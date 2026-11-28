import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as SchemaIssue from "effect/SchemaIssue";
import { Argument, Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import { expandHomePath } from "../os-jank.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { decodeSettingsFile } from "../serverSettings.ts";

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

function describeIssues(issue: SchemaIssue.Issue): string {
  return formatIssue(issue)
    .issues.map(({ path = [], message }) =>
      path.length > 0
        ? `${path.map((part) => String(typeof part === "object" ? part.key : part)).join(".")}: ${message}`
        : message,
    )
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
          ? describeIssues(error.value.issue)
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
