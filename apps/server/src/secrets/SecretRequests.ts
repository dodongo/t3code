// Answers live only in server memory, behind one-use refs; nothing a user typed is written to disk.
// A `file` request (or a value pasted in chat) streams once through an owner-only named pipe.
// A `browser` value waits at most a minute for its one fill. A restart forgets unused values.
import {
  CommandId,
  SECRET_REF_PATTERN,
  SecretRef,
  SecretRequestError,
  type ProjectId,
  type SecretReference,
  type SecretRequestAnswerInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretPipe from "./secretPipe.ts";

const SECRET_REF_PREFIX = "secret-ref:";
const keyOf = (ref: SecretRef) => ref.slice(SECRET_REF_PREFIX.length);
const SECRET_REF_TTL_MS = 24 * 60 * 60 * 1000;
/** The waiting fill polls every half second, so a value left this long has no taker. */
export const BROWSER_VALUE_TTL_MS = 60 * 1000;
/** How long a pipe waits for the one command that reads it. */
const PIPE_READ_WINDOW_MS = 30 * 60 * 1000;
/** Plaintext values that versions before memory-only answers left on disk. */
const LEGACY_STORE_NAME_PATTERN = /^(secret-request-[0-9a-f]{32})\.bin$/;

/** How the card said its value would be used; only that path may take it. */
type HeldKind = "ref" | "file" | "browser";

type HeldValue = {
  readonly kind: HeldKind;
  readonly projectId: string;
  readonly value: Redacted.Redacted<string>;
  readonly savedAt: number;
  readonly ttlMs: number;
};

export class SecretRequests extends Context.Service<
  SecretRequests,
  {
    readonly answer: (input: SecretRequestAnswerInput) => Effect.Effect<void, SecretRequestError>;
    readonly savedRef: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<Option.Option<SecretRef>>;
    readonly consume: (input: {
      readonly ref: SecretRef;
      readonly projectId: ProjectId;
    }) => Effect.Effect<string, SecretRequestError>;
    /**
     * Moves a saved `file` request's value into a one-read named pipe and returns its path.
     * The first command that reads the path gets the value; then the pipe is gone.
     */
    readonly saveToFile: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<string, SecretRequestError>;
    /** Serves a secret the user pasted in chat through a one-read named pipe; returns its path. */
    readonly savePasted: (input: {
      readonly threadId: ThreadId;
      /** The provider session's namespace, so two sessions' keys never share a pipe. */
      readonly requestNamespace: string;
      readonly requestKey: string;
      readonly value: string;
    }) => Effect.Effect<string, SecretRequestError>;
    /**
     * Takes a saved `browser` request's value out of memory. It can be taken once, within
     * `BROWSER_VALUE_TTL_MS` of the answer; after that, or a second time, there is none.
     */
    readonly takeBrowserValue: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
  }
>()("t3/secrets/SecretRequests") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const resolver = yield* SecretResolver.SecretResolver;
  const layerScope = yield* Scope.Scope;
  const pipesSupported = SecretPipe.pipesSupportedOn(yield* HostProcess.Platform);
  // Beside the store's own files so the same owner-only directory applies.
  const pipesDir = store.directory === undefined ? undefined : path.join(store.directory, "files");

  const mac = yield* Mac.Mac;
  // Keyed by the salt's hex text, as refs made by earlier versions were.
  const refKey = yield* Mac.key(
    Mac.hmacSha256,
    new TextEncoder().encode(
      Hex.encode(yield* store.getOrCreateRandom("secret-request-salt", 32).pipe(Effect.orDie)),
    ),
  ).pipe(Effect.orDie);
  const refFor = (threadId: ThreadId, turnItemId: string) =>
    mac.sign(refKey, new TextEncoder().encode(`${threadId}\u0000${turnItemId}`)).pipe(
      Effect.orDie,
      Effect.map((tag) => SecretRef.make(`${SECRET_REF_PREFIX}${Hex.encode(tag).slice(0, 32)}`)),
    );

  /** Every saved answer, by ref key. Taking one deletes it, so a value is handed out once. */
  const held = new Map<string, HeldValue>();
  /** Pipes still waiting for their reader, by path. */
  const servingPipes = new Set<string>();

  const isExpired = (entry: HeldValue, now: number) => now - entry.savedAt > entry.ttlMs;
  const dropExpired = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [key, entry] of held) if (isExpired(entry, now)) held.delete(key);
  });
  const forgetAnswer = (threadId: ThreadId, turnItemId: string) =>
    refFor(threadId, turnItemId).pipe(Effect.map((ref) => void held.delete(keyOf(ref))));

  const readReference = Effect.fn("SecretRequests.readReference")(function* (
    reference: SecretReference,
  ) {
    // The resolver keeps failed reads for the server's life; a retry after unlocking must re-read.
    yield* resolver.invalidate([reference]);
    const [value] = yield* resolver.read([reference]);
    if (value === undefined || value.trim() === "") {
      return yield* new SecretRequestError({
        reason: "reference_unreadable",
        provider: yield* resolver.label(reference.provider),
      });
    }
    return value;
  });

  const answer: SecretRequests["Service"]["answer"] = Effect.fn("SecretRequests.answer")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "secret_request.answer": input.answer.type,
      });
      const records = yield* threadManagement
        .getThreadRecords(input.threadId, ["runs", "turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
      const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
      if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
        return yield* new SecretRequestError({ reason: "not_found" });
      }
      if (item.secretStatus !== "pending") {
        return yield* new SecretRequestError({ reason: "already_answered" });
      }
      const run = records.runs.find((candidate) => candidate.id === item.runId);
      if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
        return yield* new SecretRequestError({ reason: "agent_stopped" });
      }
      // A file request can only be delivered through a pipe; refuse before taking the value.
      if (item.delivery === "file" && !pipesSupported) {
        return yield* new SecretRequestError({ reason: "file_unsupported" });
      }
      const secret =
        input.answer.type === "save"
          ? input.answer.secret
          : input.answer.type === "reference"
            ? yield* readReference(input.answer.reference)
            : undefined;
      // Hold before recording so the card never shows saved without a value behind it. A value
      // already held finishes an earlier save whose recording failed; racing answers keep it.
      if (secret !== undefined) {
        const key = keyOf(yield* refFor(input.threadId, item.id));
        if (!held.has(key)) {
          held.set(key, {
            kind: item.delivery ?? "ref",
            projectId: records.thread.projectId,
            value: Redacted.make(secret),
            savedAt: yield* Clock.currentTimeMillis,
            ttlMs: item.delivery === "browser" ? BROWSER_VALUE_TTL_MS : SECRET_REF_TTL_MS,
          });
        }
      }
      const secretStatus = secret === undefined ? "declined" : "saved";
      yield* threadManagement
        .dispatch({
          type: "secret_request.record",
          commandId: CommandId.make(`secret-request:${item.id}:${secretStatus}`),
          threadId: input.threadId,
          runId: item.runId,
          nodeId: item.nodeId,
          turnItemId: item.id,
          label: item.label,
          reason: item.reason,
          ...(item.url === undefined ? {} : { url: item.url }),
          ...(item.placeholder === undefined ? {} : { placeholder: item.placeholder }),
          ...(item.delivery === undefined ? {} : { delivery: item.delivery }),
          secretStatus,
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
          // Clear failed saves so the pending card can be answered again.
          Effect.tapError(() =>
            secret !== undefined ? forgetAnswer(input.threadId, item.id) : Effect.void,
          ),
        );
      if (secret === undefined) return;
      // The wait may have closed the card; drop unrecorded answers because no one receives their refs.
      const recorded = yield* threadManagement
        .getThreadRecords(input.threadId, ["turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
        );
      const card = recorded.turnItems.find((candidate) => candidate.id === item.id);
      if (card?.type === "secret_request" && card.secretStatus !== "saved") {
        yield* forgetAnswer(input.threadId, item.id);
        return yield* new SecretRequestError({ reason: "agent_stopped" });
      }
    },
  );

  const savedRef: SecretRequests["Service"]["savedRef"] = Effect.fn("SecretRequests.savedRef")(
    function* (input) {
      const ref = yield* refFor(input.threadId, input.turnItemId);
      return held.get(keyOf(ref))?.kind === "ref" ? Option.some(ref) : Option.none();
    },
  );

  /** A live value, removed from memory: whoever takes it is its only holder. */
  const take = Effect.fn("SecretRequests.take")(function* (input: {
    readonly key: string;
    readonly kind: HeldKind;
    readonly projectId?: ProjectId;
  }) {
    const entry = held.get(input.key);
    if (
      entry === undefined ||
      entry.kind !== input.kind ||
      (input.projectId !== undefined && entry.projectId !== input.projectId)
    ) {
      return yield* new SecretRequestError({ reason: "ref_unavailable" });
    }
    held.delete(input.key);
    if (isExpired(entry, yield* Clock.currentTimeMillis)) {
      return yield* new SecretRequestError({ reason: "ref_expired" });
    }
    return entry.value;
  });

  const consume: SecretRequests["Service"]["consume"] = Effect.fn("SecretRequests.consume")(
    function* (input) {
      if (!SECRET_REF_PATTERN.test(input.ref)) {
        return yield* new SecretRequestError({ reason: "invalid_ref" });
      }
      return Redacted.value(
        yield* take({ key: keyOf(input.ref), kind: "ref", projectId: input.projectId }),
      );
    },
    Effect.tap(() => Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "used" })),
    Effect.tapError(() =>
      Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "rejected" }),
    ),
  );

  /**
   * Makes the pipe for `key` and serves `value` through it in the background. A retry while
   * the pipe still waits gets the same path, and the first value keeps being served.
   */
  const servePipe = Effect.fn("SecretRequests.servePipe")(function* (
    key: string,
    value: Redacted.Redacted<string>,
  ) {
    if (!pipesSupported) {
      return yield* new SecretRequestError({ reason: "file_unsupported" });
    }
    if (pipesDir === undefined) return yield* new SecretRequestError({ reason: "store_failed" });
    const pipe = path.join(pipesDir, key);
    if (servingPipes.has(pipe)) return pipe;
    yield* fileSystem.makeDirectory(pipesDir, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(fileSystem.chmod(pipesDir, 0o700)),
      Effect.andThen(fileSystem.remove(pipe, { force: true })),
      Effect.andThen(
        Effect.tryPromise({
          try: () => SecretPipe.createPipe(pipe),
          catch: (cause) => new SecretRequestError({ reason: "store_failed", cause }),
        }),
      ),
      Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
    );
    servingPipes.add(pipe);
    yield* Effect.promise((signal) =>
      // Cleared in the same tick the pipe is removed, before the reader's read can finish.
      SecretPipe.servePipeOnce(pipe, new TextEncoder().encode(Redacted.value(value)), {
        windowMs: PIPE_READ_WINDOW_MS,
        signal,
      }).finally(() => servingPipes.delete(pipe)),
    ).pipe(Effect.forkIn(layerScope));
    return pipe;
  });

  const saveToFile: SecretRequests["Service"]["saveToFile"] = Effect.fn(
    "SecretRequests.saveToFile",
  )(function* (input) {
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    // Only a card that told the user the agent's commands can read the value may hand it out.
    if (
      item?.type !== "secret_request" ||
      item.secretStatus !== "saved" ||
      item.delivery !== "file"
    ) {
      return yield* new SecretRequestError({ reason: "not_a_file_request" });
    }
    const key = keyOf(yield* refFor(input.threadId, item.id));
    if (pipesDir !== undefined && servingPipes.has(path.join(pipesDir, key))) {
      return path.join(pipesDir, key);
    }
    const value = held.get(key);
    if (value?.kind !== "file") {
      return yield* new SecretRequestError({ reason: "ref_unavailable" });
    }
    const pipe = yield* servePipe(key, value.value);
    held.delete(key);
    return pipe;
  });

  const savePasted: SecretRequests["Service"]["savePasted"] = Effect.fn(
    "SecretRequests.savePasted",
  )(function* (input) {
    const ref = yield* refFor(
      input.threadId,
      `pasted\u0000${input.requestNamespace}\u0000${input.requestKey}`,
    );
    return yield* servePipe(keyOf(ref), Redacted.make(input.value));
  });

  const takeBrowserValue: SecretRequests["Service"]["takeBrowserValue"] = Effect.fn(
    "SecretRequests.takeBrowserValue",
  )(function* (input) {
    const key = keyOf(yield* refFor(input.threadId, input.turnItemId));
    return yield* take({ key, kind: "browser" }).pipe(Effect.option);
  });

  // Earlier versions kept answers and file deliveries as plaintext on disk; remove them.
  const removeLegacyPlaintext = Effect.gen(function* () {
    if (store.directory === undefined) return;
    let removed = 0;
    for (const file of yield* fileSystem.readDirectory(store.directory)) {
      const name = LEGACY_STORE_NAME_PATTERN.exec(file)?.[1];
      if (name !== undefined) {
        yield* store.remove(name);
        removed += 1;
      }
    }
    if (pipesDir !== undefined && (yield* fileSystem.exists(pipesDir))) {
      for (const file of yield* fileSystem.readDirectory(pipesDir)) {
        yield* fileSystem.remove(path.join(pipesDir, file), { force: true });
        removed += 1;
      }
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.legacy_removed": removed });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not remove secret values older versions stored", cause),
    ),
    Effect.withSpan("SecretRequests.removeLegacyPlaintext"),
  );
  yield* removeLegacyPlaintext;
  yield* dropExpired.pipe(
    Effect.delay("15 seconds"),
    Effect.repeat(Schedule.spaced("15 seconds")),
    Effect.forkScoped,
  );

  return SecretRequests.of({
    answer,
    savedRef,
    consume,
    saveToFile,
    savePasted,
    takeBrowserValue,
  });
});

export const layer = Layer.effect(SecretRequests, make);
