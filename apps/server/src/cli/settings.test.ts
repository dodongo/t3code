import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import * as TestConsole from "effect/testing/TestConsole";

import { cli } from "../binCli.ts";

const runCheck = (raw?: string, settings?: ManagedPolicyDocument["settings"]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-check-" });
    const file = path.join(home, "settings.json");
    const policy = path.join(home, "policy.json");
    yield* fs.writeFileString(
      policy,
      JSON.stringify({ schemaVersion: 1, organization: "Settings Check Test", settings }),
    );
    if (raw !== undefined) yield* fs.writeFileString(file, raw);
    const result = yield* Command.runWith(cli, { version: "0.0.0" })([
      "settings",
      "check",
      "~/settings.json",
    ]).pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ T3CODE_DEV_MANAGED_POLICY_PATH: policy }),
      ),
      Effect.result,
    );
    return { result, file, lines: yield* TestConsole.logLines };
  }).pipe(Effect.provide(Layer.fresh(TestConsole.layer)));

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))((it) => {
  it.effect("settings check: accepts lenient JSON and prints one confirmation", () =>
    Effect.gen(function* () {
      const { result, file, lines } = yield* runCheck('{ /* user settings */ "theme": "dark", }');
      assert.isTrue(result._tag === "Success");
      assert.deepEqual(lines, [`Settings file is valid: ${file}`]);
    }),
  );

  it.effect("settings check: applies a policy default before decoding", () =>
    Effect.gen(function* () {
      const raw = '{"delegation":{"profiles":{}}}';
      const withoutDefault = yield* runCheck(raw);
      assert.isTrue(withoutDefault.result._tag === "Failure");
      if (withoutDefault.result._tag === "Failure") {
        assert.include(String(withoutDefault.result.failure), "delegation.providerByVendor");
      }
      const withDefault = yield* runCheck(raw, {
        "delegation.providerByVendor": { value: {}, locked: false },
      });
      if (withDefault.result._tag === "Failure")
        return yield* Effect.fail(withDefault.result.failure);
      assert.deepEqual(withDefault.lines, [`Settings file is valid: ${withDefault.file}`]);
    }),
  );

  it.effect("settings check: reports the allowed range without the rejected value", () =>
    Effect.gen(function* () {
      const { result } = yield* runCheck('{"sidebarAutoSettleAfterDays":987654321}');
      assert.isTrue(result._tag === "Failure");
      if (result._tag !== "Failure") return;
      assert.instanceOf(result.failure, CliError.UserError);
      const message = String(result.failure);
      assert.include(message, "sidebarAutoSettleAfterDays");
      assert.include(message, "between 1 and 90");
      assert.notInclude(message, "987654321");
    }),
  );

  it.effect.each([
    [
      "rejects an unknown delegation profile field",
      '{"delegation":{"providerByVendor":{},"profiles":{"advisor":{"model":"openai:test","deniedSkills":[],"checkout":"shared","bogus":true}}}}',
      "delegation.profiles.advisor: Unknown delegation profile field.",
    ],
    [
      "rejects an unknown delegation profile option",
      '{"delegation":{"providerByVendor":{},"profiles":{"advisor":{"model":"openai:test","deniedSkills":[],"checkout":"shared","options":{"bogus":"private-content"}}}}}',
      "delegation.profiles.advisor.options: Unknown delegation profile field.",
    ],
    ["rejects malformed JSON", '{"private-content":', "valid JSON"],
    ["rejects invalid legacy provider settings", '{"providers":"private-content"}', "providers"],
    ["rejects a missing file", undefined, "Cannot read settings file"],
  ] as const)("settings check: %s", ([_scenario, raw, detail]) =>
    Effect.gen(function* () {
      const { result, file, lines } = yield* runCheck(raw);
      assert.isTrue(result._tag === "Failure");
      if (result._tag !== "Failure") return;
      assert.instanceOf(result.failure, CliError.UserError);
      assert.include(String(result.failure), file);
      assert.include(String(result.failure), detail);
      assert.notInclude(String(result.failure), "private-content");
      assert.deepEqual(lines, []);
    }),
  );
});
