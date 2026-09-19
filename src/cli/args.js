import { readFileSync } from "node:fs";
import { z } from "zod";

const GLOBAL_FLAGS = new Set(["out", "compact", "help"]);

function unwrap(schema) {
  let current = schema;
  let optional = false;
  // Peel ZodOptional / ZodDefault / ZodNullable wrappers to reach the base type.
  for (;;) {
    const typeName = current?._def?.typeName;
    if (typeName === "ZodOptional" || typeName === "ZodNullable") {
      optional = true;
      current = current._def.innerType;
    } else if (typeName === "ZodDefault") {
      optional = true;
      current = current._def.innerType;
    } else {
      break;
    }
  }
  return { base: current, optional, typeName: current?._def?.typeName ?? "unknown" };
}

function kindOf(schema) {
  const { typeName } = unwrap(schema);
  switch (typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodArray": {
      const inner = unwrap(unwrap(schema).base._def.type).typeName;
      return inner === "ZodString" ? "string[]" : "json";
    }
    case "ZodRecord":
    case "ZodObject":
    case "ZodAny":
      return "json";
    case "ZodEnum":
      return "string";
    default:
      return "json";
  }
}

function normalizeKey(flag) {
  return flag.replace(/^--/, "").replace(/-/g, "_");
}

function readValueSource(value, key) {
  if (typeof value === "string" && value.startsWith("@") && value.length > 1) {
    try {
      return readFileSync(value.slice(1), "utf8");
    } catch (error) {
      throw new UsageError(`--${key}: cannot read ${value.slice(1)} (${error.code ?? error.message})`);
    }
  }
  return value;
}

function coerce(kind, raw, key) {
  const value = readValueSource(raw, key);
  switch (kind) {
    case "string":
      return String(value);
    case "number": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new UsageError(`--${key} expects a number, got "${value}"`);
      return parsed;
    }
    case "boolean":
      if (value === true || value === "true" || value === "1" || value === "yes") return true;
      if (value === false || value === "false" || value === "0" || value === "no") return false;
      throw new UsageError(`--${key} expects true/false, got "${value}"`);
    case "string[]": {
      const trimmed = String(value).trim();
      if (trimmed.startsWith("[")) {
        try {
          return JSON.parse(trimmed);
        } catch (error) {
          throw new UsageError(`--${key} expects a JSON array or comma-separated values: ${error.message}`);
        }
      }
      return trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
    case "json":
    default: {
      try {
        return JSON.parse(String(value));
      } catch (error) {
        throw new UsageError(`--${key} expects JSON (inline or @file.json): ${error.message}`);
      }
    }
  }
}

class UsageError extends Error {}

function tokenize(argv) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    const eq = token.indexOf("=");
    let key;
    let value;
    if (eq !== -1) {
      key = normalizeKey(token.slice(0, eq));
      value = token.slice(eq + 1);
    } else {
      key = normalizeKey(token);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index++;
      } else {
        value = true;
      }
    }
    if (key.startsWith("no_") && value === true) {
      flags.set(key.slice(3), false);
    } else {
      flags.set(key, value);
    }
  }
  return { flags, positionals };
}

function parseToolArgs(schema, flags) {
  const args = {};
  const known = new Set(Object.keys(schema));
  for (const [key, raw] of flags) {
    if (GLOBAL_FLAGS.has(key)) continue;
    if (!known.has(key)) {
      throw new UsageError(`Unknown flag --${key.replace(/_/g, "-")}. Known: ${[...known].map((name) => `--${name.replace(/_/g, "-")}`).join(", ") || "(none)"}`);
    }
    const kind = kindOf(schema[key]);
    if (raw === true && kind !== "boolean") throw new UsageError(`--${key.replace(/_/g, "-")} needs a value`);
    args[key] = coerce(kind, raw, key.replace(/_/g, "-"));
  }
  const result = z.object(schema).safeParse(args);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `--${(issue.path[0] ?? "?").toString().replace(/_/g, "-")}: ${issue.message}`)
      .join("; ");
    throw new UsageError(issues);
  }
  return result.data;
}

function describeSchema(schema) {
  return Object.entries(schema).map(([key, field]) => {
    const { optional } = unwrap(field);
    return {
      flag: `--${key.replace(/_/g, "-")}`,
      kind: kindOf(field),
      required: !optional,
      description: field?.description ?? field?._def?.description ?? "",
    };
  });
}

export { UsageError, describeSchema, kindOf, parseToolArgs, tokenize };
