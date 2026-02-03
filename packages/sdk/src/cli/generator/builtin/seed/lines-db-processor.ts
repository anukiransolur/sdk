import ml from "multiline-ts";
import type { LinesDbMetadata, PluginSourceInfo } from "./types";
import type { TypeSourceInfoEntry } from "@/cli/generator/types";
import type { ParsedTailorDBType, OperatorFieldConfig } from "@/parser/service/tailordb/types";
import type { ForeignKeyDefinition, IndexDefinition } from "@toiroakr/lines-db";

/**
 * Processes TailorDB types to generate lines-db metadata
 * @param type - Parsed TailorDB type
 * @param source - Source file info
 * @returns Generated lines-db metadata
 */
export function processLinesDb(
  type: ParsedTailorDBType,
  source: TypeSourceInfoEntry,
): LinesDbMetadata {
  // Plugin-generated types don't have a source file path
  const isPluginGenerated = !!source.pluginId;
  if (!isPluginGenerated && !source.filePath) {
    throw new Error(`Missing source info for type ${type.name}`);
  }
  if (!source.exportName) {
    throw new Error(`Missing export name for type ${type.name}`);
  }

  const optionalFields = ["id"]; // id is always optional
  const omitFields = [];
  const indexes: IndexDefinition[] = [];
  const foreignKeys: ForeignKeyDefinition[] = [];

  // Find fields with hooks.create or serial
  for (const [fieldName, field] of Object.entries(type.fields)) {
    if (field.config.hooks?.create) {
      optionalFields.push(fieldName);
    }
    // Serial fields are auto-generated, so they should be optional in seed data
    if (field.config.serial) {
      omitFields.push(fieldName);
    }
    if (field.config.unique) {
      indexes.push({
        name: `${type.name.toLowerCase()}_${fieldName}_unique_idx`,
        columns: [fieldName],
        unique: true,
      });
    }
  }

  // Extract indexes
  if (type.indexes) {
    for (const [indexName, indexDef] of Object.entries(type.indexes)) {
      indexes.push({
        name: indexName,
        columns: indexDef.fields,
        unique: indexDef.unique,
      });
    }
  }

  // Extract foreign keys from relations
  for (const [fieldName, field] of Object.entries(type.fields)) {
    if (field.relation) {
      foreignKeys.push({
        column: fieldName,
        references: {
          table: field.relation.targetType,
          column: field.relation.key,
        },
      });
    }
  }

  // Build plugin source info if this is a plugin-generated type
  const pluginSource: PluginSourceInfo | undefined =
    source.pluginId && source.originalFilePath && source.originalExportName
      ? {
          pluginId: source.pluginId,
          originalFilePath: source.originalFilePath,
          originalExportName: source.originalExportName,
        }
      : undefined;

  return {
    typeName: type.name,
    exportName: source.exportName,
    importPath: source.filePath,
    optionalFields,
    omitFields,
    foreignKeys,
    indexes,
    pluginSource,
  };
}

/**
 * Generate schema options code for lines-db
 * @param foreignKeys - Foreign key definitions
 * @param indexes - Index definitions
 * @returns Schema options code string
 */
function generateSchemaOptions(
  foreignKeys: ForeignKeyDefinition[],
  indexes: IndexDefinition[],
): string {
  const schemaOptions: string[] = [];

  if (foreignKeys.length > 0) {
    schemaOptions.push(`foreignKeys: [`);
    foreignKeys.forEach((fk) => {
      schemaOptions.push(`  ${JSON.stringify(fk)},`);
    });
    schemaOptions.push(`],`);
  }

  if (indexes.length > 0) {
    schemaOptions.push(`indexes: [`);
    indexes.forEach((index) => {
      schemaOptions.push(`  ${JSON.stringify(index)},`);
    });
    schemaOptions.push("],");
  }

  return schemaOptions.length > 0
    ? ["\n  {", ...schemaOptions.map((option) => `    ${option}`), "  }"].join("\n")
    : "";
}

/**
 * Generates the schema file content for lines-db (for user-defined types with import)
 * @param metadata - lines-db metadata
 * @param importPath - Import path for the TailorDB type
 * @returns Schema file contents
 */
export function generateLinesDbSchemaFile(metadata: LinesDbMetadata, importPath: string): string {
  const { exportName, optionalFields, omitFields, foreignKeys, indexes } = metadata;

  const schemaTypeCode = ml /* ts */ `
    const schemaType = t.object({
      ...${exportName}.pickFields(${JSON.stringify(optionalFields)}, { optional: true }),
      ...${exportName}.omitFields(${JSON.stringify([...optionalFields, ...omitFields])}),
    });
    `;

  const schemaOptionsCode = generateSchemaOptions(foreignKeys, indexes);

  return ml /* ts */ `
    import { t } from "@tailor-platform/sdk";
    import { createTailorDBHook, createStandardSchema } from "@tailor-platform/sdk/test";
    import { defineSchema } from "@toiroakr/lines-db";
    import { ${exportName} } from "${importPath}";

    ${schemaTypeCode}

    const hook = createTailorDBHook(${exportName});

    export const schema = defineSchema(
      createStandardSchema(schemaType, hook),${schemaOptionsCode}
    );

    `;
}

/**
 * Generates the schema file content for lines-db with embedded type definition
 * (for plugin-generated types that don't have a source file)
 * @param metadata - lines-db metadata
 * @param typeDefinition - Embedded type definition code
 * @returns Schema file contents
 */
export function generateLinesDbSchemaFileWithEmbeddedType(
  metadata: LinesDbMetadata,
  typeDefinition: string,
): string {
  const { exportName, optionalFields, omitFields, foreignKeys, indexes } = metadata;

  const schemaTypeCode = ml /* ts */ `
    const schemaType = t.object({
      ...${exportName}.pickFields(${JSON.stringify(optionalFields)}, { optional: true }),
      ...${exportName}.omitFields(${JSON.stringify([...optionalFields, ...omitFields])}),
    });
    `;

  const schemaOptionsCode = generateSchemaOptions(foreignKeys, indexes);

  return ml /* ts */ `
    import { db, t } from "@tailor-platform/sdk";
    import { createTailorDBHook, createStandardSchema } from "@tailor-platform/sdk/test";
    import { defineSchema } from "@toiroakr/lines-db";

    ${typeDefinition}

    ${schemaTypeCode}

    const hook = createTailorDBHook(${exportName});

    export const schema = defineSchema(
      createStandardSchema(schemaType, hook),${schemaOptionsCode}
    );

    `;
}

/**
 * Extract the original function from a hook/validate expression.
 * The expr format is: `(originalFunction)({ value: _value, data: _data, user: ... })`
 * This extracts just the `originalFunction` part.
 * @param expr - The expression string from hooks or validate
 * @returns The extracted function string, or null if extraction fails
 */
function extractFunctionFromExpr(expr: string): string | null {
  // The expr starts with `(` and we need to find the matching `)`
  // that ends the function definition (before the invocation arguments)
  if (!expr.startsWith("(")) {
    return null;
  }

  let depth = 0;
  let endIndex = -1;

  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === "(") {
      depth++;
    } else if (expr[i] === ")") {
      depth--;
      if (depth === 0) {
        endIndex = i;
        break;
      }
    }
  }

  if (endIndex === -1) {
    return null;
  }

  // Extract the function (without the outer parentheses)
  return expr.slice(1, endIndex);
}

/**
 * Convert a field type to its db.* method call string.
 * @param fieldConfig - Field configuration
 * @returns db.* method call string (e.g., "db.string()", "db.uuid({ optional: true })")
 */
function fieldConfigToDbCall(fieldConfig: OperatorFieldConfig): string {
  // Determine if the field is optional (not required means optional)
  const isOptional = !fieldConfig.required;
  const isArray = fieldConfig.array;

  // Build options object for the db.* method call
  const buildOptions = (): string => {
    const opts: string[] = [];
    if (isOptional) opts.push("optional: true");
    if (isArray) opts.push("array: true");
    return opts.length > 0 ? `{ ${opts.join(", ")} }` : "";
  };

  let baseCall: string;
  const options = buildOptions();

  // Map field type to db method
  switch (fieldConfig.type) {
    case "string":
      baseCall = options ? `db.string(${options})` : "db.string()";
      break;
    case "uuid":
      baseCall = options ? `db.uuid(${options})` : "db.uuid()";
      break;
    case "integer":
      baseCall = options ? `db.int(${options})` : "db.int()";
      break;
    case "float":
      baseCall = options ? `db.float(${options})` : "db.float()";
      break;
    case "boolean":
      baseCall = options ? `db.bool(${options})` : "db.bool()";
      break;
    case "date":
      baseCall = options ? `db.date(${options})` : "db.date()";
      break;
    case "datetime":
      baseCall = options ? `db.datetime(${options})` : "db.datetime()";
      break;
    case "time":
      baseCall = options ? `db.time(${options})` : "db.time()";
      break;
    case "enum":
      if (fieldConfig.allowedValues && fieldConfig.allowedValues.length > 0) {
        const values = fieldConfig.allowedValues.map((v) => {
          if (v.description) {
            return `{ value: "${v.value}", description: "${v.description}" }`;
          }
          return `"${v.value}"`;
        });
        baseCall = `db.enum([${values.join(", ")}]${options ? `, ${options}` : ""})`;
      } else {
        baseCall = `db.enum([]${options ? `, ${options}` : ""})`;
      }
      break;
    case "nested":
      if (fieldConfig.fields && Object.keys(fieldConfig.fields).length > 0) {
        const nestedFields = Object.entries(fieldConfig.fields)
          .map(([name, config]) => `    ${name}: ${fieldConfigToDbCall(config)},`)
          .join("\n");
        baseCall = `db.nested({\n${nestedFields}\n  }${options ? `, ${options}` : ""})`;
      } else {
        baseCall = `db.nested({}${options ? `, ${options}` : ""})`;
      }
      break;
    default:
      // For unknown types, use string as fallback
      baseCall = options ? `db.string(${options})` : "db.string()";
  }

  // Apply chain modifiers
  const modifiers: string[] = [];

  if (fieldConfig.description) {
    modifiers.push(`.description("${fieldConfig.description.replace(/"/g, '\\"')}")`);
  }

  if (fieldConfig.index) {
    modifiers.push(".index()");
  }

  if (fieldConfig.unique) {
    modifiers.push(".unique()");
  }

  // vector is only valid for non-array string fields
  if (fieldConfig.vector && fieldConfig.type === "string" && !fieldConfig.array) {
    modifiers.push(".vector()");
  }

  // serial configuration for integer or string fields
  if (fieldConfig.serial) {
    const serialOpts: string[] = [];
    serialOpts.push(`start: ${fieldConfig.serial.start}`);
    if (fieldConfig.serial.maxValue !== undefined) {
      serialOpts.push(`maxValue: ${fieldConfig.serial.maxValue}`);
    }
    if (fieldConfig.serial.format !== undefined) {
      serialOpts.push(`format: "${fieldConfig.serial.format.replace(/"/g, '\\"')}"`);
    }
    modifiers.push(`.serial({ ${serialOpts.join(", ")} })`);
  }

  // hooks: extract the original function from the expr
  if (fieldConfig.hooks) {
    const hookEntries: string[] = [];
    if (fieldConfig.hooks.create?.expr) {
      const fn = extractFunctionFromExpr(fieldConfig.hooks.create.expr);
      if (fn) {
        hookEntries.push(`create: ${fn}`);
      }
    }
    if (fieldConfig.hooks.update?.expr) {
      const fn = extractFunctionFromExpr(fieldConfig.hooks.update.expr);
      if (fn) {
        hookEntries.push(`update: ${fn}`);
      }
    }
    if (hookEntries.length > 0) {
      modifiers.push(`.hooks({ ${hookEntries.join(", ")} })`);
    }
  }

  // validate: extract the original function from the expr
  if (fieldConfig.validate && fieldConfig.validate.length > 0) {
    const validateArgs = fieldConfig.validate
      .map((v) => {
        const fn = extractFunctionFromExpr(v.script.expr);
        if (fn) {
          return `[${fn}, "${v.errorMessage.replace(/"/g, '\\"')}"]`;
        }
        return null;
      })
      .filter(Boolean);
    if (validateArgs.length > 0) {
      modifiers.push(`.validate(${validateArgs.join(", ")})`);
    }
  }

  return baseCall + modifiers.join("");
}

/**
 * Convert a standard permission operand back to user format.
 * @param operand - Standard permission operand
 * @returns User format operand string
 */
function operandToString(operand: unknown): string {
  if (typeof operand === "object" && operand !== null) {
    if ("user" in operand) {
      const userKey = (operand as { user: string }).user;
      // Convert _id back to id
      const key = userKey === "_id" ? "id" : userKey;
      return `{ user: "${key}" }`;
    }
    if ("value" in operand) {
      const val = (operand as { value: unknown }).value;
      return `{ value: ${JSON.stringify(val)} }`;
    }
    if ("record" in operand) {
      return `{ record: "${(operand as { record: string }).record}" }`;
    }
  }
  // Literal value
  return JSON.stringify(operand);
}

/**
 * Convert standard operator back to user format.
 * @param op - Standard operator (eq, ne, in, nin)
 * @returns User format operator
 */
function operatorToString(op: string): string {
  const map: Record<string, string> = {
    eq: "=",
    ne: "!=",
    in: "in",
    nin: "not in",
  };
  return map[op] || op;
}

/**
 * Generate gqlPermission chain method call.
 * @param gql - Standard GQL permissions
 * @returns gqlPermission method call string
 */
function generateGqlPermissionCall(
  gql: { conditions: unknown[]; actions: unknown[]; permit: string; description?: string }[],
): string {
  const policies = gql.map((policy) => {
    const parts: string[] = [];

    // conditions
    const conditions = (policy.conditions as unknown[][]).map((cond) => {
      const [left, op, right] = cond;
      return `[${operandToString(left)}, "${operatorToString(op as string)}", ${operandToString(right)}]`;
    });
    parts.push(`conditions: [${conditions.join(", ")}]`);

    // actions
    const actions = policy.actions as string[];
    parts.push(`actions: [${actions.map((a) => `"${a}"`).join(", ")}]`);

    // permit (convert "allow"/"deny" back to boolean)
    parts.push(`permit: ${policy.permit === "allow"}`);

    // description (optional)
    if (policy.description) {
      parts.push(`description: "${policy.description.replace(/"/g, '\\"')}"`);
    }

    return `{ ${parts.join(", ")} }`;
  });

  return `.gqlPermission([${policies.join(", ")}])`;
}

/**
 * Generate TypeScript type definition for a plugin-generated TailorDB type.
 * Returns only the type definition (without imports or file headers) for embedding in schema files.
 * @param type - Parsed TailorDB type
 * @returns TypeScript type definition code
 */
export function generatePluginTypeDefinition(type: ParsedTailorDBType): string {
  // Generate field definitions, excluding 'id' since db.type() adds it automatically
  const fieldEntries = Object.entries(type.fields)
    .filter(([name]) => name !== "id")
    .map(([name, field]) => `  ${name}: ${fieldConfigToDbCall(field.config)},`)
    .join("\n");

  // Check if we need to add timestamps
  const hasCreatedAt = "createdAt" in type.fields;
  const hasUpdatedAt = "updatedAt" in type.fields;
  const hasTimestamps = hasCreatedAt && hasUpdatedAt;

  // Filter out timestamp fields if they exist
  const nonTimestampFields = Object.entries(type.fields)
    .filter(([name]) => name !== "id" && name !== "createdAt" && name !== "updatedAt")
    .map(([name, field]) => `  ${name}: ${fieldConfigToDbCall(field.config)},`)
    .join("\n");

  const fieldsContent = hasTimestamps
    ? `${nonTimestampFields}\n  ...db.fields.timestamps(),`
    : fieldEntries;

  // Build type definition with optional method chains
  let result = `const ${type.name} = db.type("${type.name}", {\n${fieldsContent}\n})`;

  // Add gqlPermission if defined
  if (type.permissions.gql && type.permissions.gql.length > 0) {
    result += generateGqlPermissionCall(
      type.permissions.gql as unknown as {
        conditions: unknown[];
        actions: unknown[];
        permit: string;
        description?: string;
      }[],
    );
  }

  return `${result};`;
}
