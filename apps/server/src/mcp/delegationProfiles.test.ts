import {
  ProviderDriverKind,
  ProviderInstanceId,
  type DelegationSettings,
  type ServerProvider,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import {
  ANTIGRAVITY_PROFILE_THINKING_OPTION,
  applyAntigravityAcpModelSelection,
} from "../provider/acp/AntigravityAcpSupport.ts";
import { resolveDelegationModel, resolveDelegationRoute } from "./delegationProfiles.ts";

const antigravityId = ProviderInstanceId.make("agy-work");
const gemini = {
  slug: "gemini-test",
  name: "Gemini Test",
  aliases: ["gemini-alias"],
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        type: "select",
        id: "native-thought-level",
        role: "reasoning",
        label: "Thinking",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
    ],
  },
} as const satisfies ServerProvider["models"][number];

const antigravity = {
  instanceId: antigravityId,
  driver: ProviderDriverKind.make("antigravity"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-24T00:00:00.000Z",
  models: [gemini],
  slashCommands: [],
  skills: [],
} as const satisfies ServerProvider;

const profile = {
  model: "google:gemini-test",
  deniedSkills: [],
  checkout: "shared",
} as const satisfies DelegationSettings["profiles"][string];

describe("resolveDelegationRoute", () => {
  it.effect("uses the vendor before the first colon and the configured instance", () =>
    Effect.gen(function* () {
      const pi = ProviderInstanceId.make("pi-bedrock");
      const routes = { openai: pi };
      const route = yield* resolveDelegationRoute(routes, "openai:amazon-bedrock/openai-model:go");
      assert.deepEqual(route, {
        vendor: "openai",
        model: "amazon-bedrock/openai-model:go",
        driver: "pi",
        instanceId: pi,
      });
      const unmapped = yield* resolveDelegationRoute(routes, "anthropic:claude-alias");
      assert.equal(unmapped.driver, "claudeAgent");
      assert.isNull(unmapped.instanceId);
      const unknown = yield* resolveDelegationRoute(routes, "bedrock:openai-model").pipe(
        Effect.flip,
      );
      assert.equal(unknown.code, "model_unavailable");
    }),
  );
});

describe("resolveDelegationModel", () => {
  it.effect.each([
    { model: "gemini-4-neon", switchModel: true },
    { model: "gemini-4-neon-high", switchModel: true },
    { model: "gemini-4-neon-medium", conflict: true },
    { model: "antigravity-default", switchModel: false },
  ])(
    "resolves cold Antigravity selection $model against the live session",
    ({ model, switchModel, conflict }) =>
      Effect.gen(function* () {
        const selected = yield* resolveDelegationModel({
          provider: { ...antigravity, models: [] },
          model,
          profile: { ...profile, options: { thinking: "high" } },
        });
        assert.deepEqual(selected, {
          instanceId: antigravityId,
          model,
          options: [{ id: "t3:antigravity-profile-thinking", value: "high" }],
        });

        const requests: unknown[] = [];
        let currentModel = "gemini-default";
        const getConfigOptions = Effect.sync(
          () =>
            [
              {
                id: "model",
                name: "Model",
                type: "select",
                currentValue: currentModel,
                options: [
                  { value: "gemini-default", name: "Gemini default" },
                  { value: "gemini-4-neon", name: "Gemini 4 Neon" },
                ],
              },
              {
                id: currentModel === "gemini-default" ? "default_thinking" : "native_neon_thinking",
                name: "Thinking",
                type: "select",
                category: "thought_level",
                currentValue: "medium",
                options: [
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" },
                ],
              },
            ] as const,
        );
        const apply = applyAntigravityAcpModelSelection({
          runtime: {
            getConfigOptions,
            setModel: (value) =>
              Effect.sync(() => {
                currentModel = value;
                requests.push({ id: "model", value });
              }),
            setConfigOption: (id, value) =>
              Effect.gen(function* () {
                requests.push({ id, value });
                return { configOptions: yield* getConfigOptions };
              }),
          },
          model: selected.model,
          profileThinking: getModelSelectionStringOptionValue(
            selected,
            ANTIGRAVITY_PROFILE_THINKING_OPTION,
          ),
          mapError: (cause) => cause,
        });
        if (conflict) {
          const error = yield* apply.pipe(Effect.flip);
          assert.propertyVal(
            error,
            "errorMessage",
            "Model gemini-4-neon-medium specifies thinking medium, which conflicts with profile thinking high.",
          );
          assert.deepEqual(requests, []);
        } else {
          assert.equal(yield* apply, switchModel ? "gemini-4-neon" : "gemini-default");
          assert.deepEqual(
            requests,
            switchModel
              ? [
                  { id: "model", value: "gemini-4-neon" },
                  { id: "native_neon_thinking", value: "high" },
                ]
              : [{ id: "default_thinking", value: "high" }],
          );
        }
      }),
  );

  it.effect.each([
    { driver: "pi", model: "openai/test", option: "thinking" },
    { driver: "claudeAgent", model: "claude-test", option: "effort" },
    { driver: "antigravity", model: "gemini-4-neon-high", option: undefined },
  ] as const)(
    "keeps the cold $driver selection without adding unspecified thinking",
    ({ driver, model, option }) =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make(`${driver}-work`);
        const provider = {
          ...antigravity,
          instanceId,
          driver: ProviderDriverKind.make(driver),
          models: [],
        };
        assert.deepEqual(yield* resolveDelegationModel({ provider, model, profile }), {
          instanceId,
          model,
        });
        if (option !== undefined) {
          assert.deepEqual(
            yield* resolveDelegationModel({
              provider,
              model,
              profile: { ...profile, options: { thinking: "high" } },
            }),
            {
              instanceId,
              model,
              options: [{ id: option, value: "high" }],
            },
          );
        }
      }),
  );

  it.effect("rejects an unknown model in a populated catalog", () =>
    Effect.gen(function* () {
      const error = yield* resolveDelegationModel({
        provider: antigravity,
        model: "gemini-unknown",
        profile,
      }).pipe(Effect.flip);
      assert.equal(error.code, "model_unavailable");
      assert.equal(
        error.message,
        "Model gemini-unknown is not advertised by provider agy-work. Use orchestrator_capabilities with search to find models.",
      );
    }),
  );

  it.effect.each([
    { title: "advertised alias", model: "gemini-alias", expectedModel: "gemini-alias" },
    {
      title: "legacy reference in a modern catalog",
      model: "gemini-test-high",
      expectedModel: "gemini-test",
    },
  ])("selects the live reasoning option ID for $title", ({ model, expectedModel }) =>
    Effect.gen(function* () {
      const selected = yield* resolveDelegationModel({
        provider: antigravity,
        model,
        profile: { ...profile, options: { thinking: "high" } },
      });
      assert.deepEqual(selected, {
        instanceId: antigravityId,
        model: expectedModel,
        options: [{ id: "native-thought-level", value: "high" }],
      });
    }),
  );

  it.effect("keeps a directly advertised legacy model with no separate thinking option", () =>
    Effect.gen(function* () {
      const model = "gemini-test-high";
      const provider = {
        ...antigravity,
        models: [{ slug: model, name: "Gemini High", isCustom: false, capabilities: null }],
      };
      assert.deepEqual(yield* resolveDelegationModel({ provider, model, profile }), {
        instanceId: antigravityId,
        model,
      });
      const unconfirmed = yield* resolveDelegationModel({
        provider,
        model,
        profile: { ...profile, options: { thinking: "high" } },
      }).pipe(Effect.flip);
      assert.equal(unconfirmed.code, "model_unavailable");
      assert.include(unconfirmed.message, "does not advertise thinking high");
    }),
  );

  it.effect.each([
    { model: "gemini-test-high", thinking: "medium", reason: "conflicts" },
    { model: "gemini-test", thinking: "xhigh", reason: "does not advertise thinking xhigh" },
  ])("refuses unsupported thinking $thinking for $model", ({ model, thinking, reason }) =>
    Effect.gen(function* () {
      const error = yield* resolveDelegationModel({
        provider: antigravity,
        model,
        profile: { ...profile, options: { thinking } },
      }).pipe(Effect.flip);
      assert.equal(error.code, "model_unavailable");
      assert.include(error.message, reason);
    }),
  );
});
