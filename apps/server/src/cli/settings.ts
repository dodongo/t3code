import { DelegationSettings } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { Argument, Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import { expandHomePath } from "../os-jank.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { decodeSettingsFile } from "../serverSettings.ts";

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => {
    switch (issue._tag) {
      case "InvalidType":
        return `Expected ${issue.ast}`;
      case "InvalidValue":
        return issue.annotations?.expected
          ? `Expected ${issue.annotations.expected}`
          : "Invalid value";
      case "MissingKey":
        return "Missing key";
      case "UnexpectedKey":
        return "Unexpected key";
      case "OneOf":
        return "Expected exactly one schema to match";
      case "Forbidden":
        return "Invalid JSON or unsupported value";
    }
  },
  checkHook: (issue) => SchemaIssue.defaultCheckHook(issue) ?? "Invalid value",
});

const readDiagnosticJson = Schema.decodeUnknownOption(fromLenientJson(Schema.Unknown));

function describeIssues(issue: SchemaIssue.Issue, raw: string): string {
  const profile = DelegationSettings.fields.profiles.value.schema;
  return formatIssue(issue)
    .issues.flatMap(({ path = [], message }) => {
      const segments = path.map((part) => String(typeof part === "object" ? part.key : part));
      if (
        message === "Unknown delegation profile field." &&
        segments[0] === "delegation" &&
        segments[1] === "profiles"
      ) {
        const schema =
          segments.length === 3
            ? profile
            : segments.length === 4 && segments[3] === "options"
              ? profile.fields.options.schema.schema
              : undefined;
        if (schema !== undefined) {
          const input = segments.reduce<unknown>(
            (value, key) =>
              typeof value === "object" && value !== null && Object.hasOwn(value, key)
                ? Reflect.get(value, key)
                : undefined,
            Option.getOrUndefined(readDiagnosticJson(raw)),
          );
          if (typeof input === "object" && input !== null) {
            const unknownKeys = Object.keys(input).filter(
              (key) => !Object.hasOwn(schema.fields, key),
            );
            if (unknownKeys.length > 0) {
              return unknownKeys.map(
                (key) => `${segments.join(".")}.${JSON.stringify(key).slice(1, -1)}: ${message}`,
              );
            }
          }
        }
      }
      return segments.length > 0 ? `${segments.join(".")}: ${message}` : message;
    })
    .join("\n");
}

const checkCommand = Command.make("check", {
  file: Argument.String("file").pipe(Argument.withDescription("Settings file to validate.")),
}).pipe(
  Command.withDescription("Validate a settings file before installing it."),
  Command.withHandler(
    Effect.fn("cli.settings.check")(function* ({ file }) {
      const path = yield* expandHomePath(file);
      const fs = yield* FileSystem.FileSystem;
      const raw = yield* fs.readFileString(path).pipe(
        Effect.mapError(
          (error) =>
            new CliError.UserError({
              cause: error,
              userMessage: `Cannot read settings file at ${path}: ${error.message}`,
            }),
        ),
      );
      const { settings } = yield* ManagedPolicy.ManagedPolicy.pipe(
        Effect.provide(ManagedPolicy.layer),
        Effect.provideService(References.MinimumLogLevel, "Warn"),
      );
      const { failure } = decodeSettingsFile(raw, settings);
      if (failure !== undefined) {
        const error = Cause.findErrorOption(failure);
        const details = Option.isSome(error)
          ? describeIssues(error.value.issue, raw)
          : "Could not decode settings.";
        return yield* new CliError.UserError({
          cause: path,
          userMessage: `Invalid settings file at ${path}: ${details}`,
        });
      }
      yield* Console.log(`Settings file is valid: ${path}`);
    }),
  ),
);

export const settingsCommand = Command.make("settings").pipe(
  Command.withDescription("Check T3 Code settings files."),
  Command.withSubcommands([checkCommand]),
);
