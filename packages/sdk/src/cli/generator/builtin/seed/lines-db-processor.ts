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

  // Apply chain modifiers (index, unique, description, foreignKey)
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

  if (fieldConfig.foreignKey && fieldConfig.foreignKeyType) {
    modifiers.push(`.foreignKey("${fieldConfig.foreignKeyType}")`);
  }

  return baseCall + modifiers.join("");
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

  return `const ${type.name} = db.type("${type.name}", {\n${fieldsContent}\n});`;
}
