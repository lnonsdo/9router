function isPlainObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }

export function coerceSchemaNumericFields(schema) {
  if (!isPlainObject(schema)) return schema;
  const result = { ...schema };
  // Numeric fields to coerce from string to number
  const numericKeys = ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"];
  for (const key of numericKeys) {
    if (result[key] !== undefined) {
      const n = Number(result[key]);
      result[key] = Number.isFinite(n) ? n : result[key];
    }
  }
  // Strip default keyword (some providers reject it)
  delete result.default;
  // Recurse into nested objects
  const recurseKeys = ["properties", "patternProperties", "definitions", "$defs", "items", "additionalProperties", "anyOf", "oneOf", "allOf"];
  for (const key of recurseKeys) {
    if (result[key] !== undefined) {
      if (Array.isArray(result[key])) {
        result[key] = result[key].map(item => coerceSchemaNumericFields(item));
      } else if (isPlainObject(result[key])) {
        result[key] = coerceSchemaNumericFields(result[key]);
      }
    }
  }
  return result;
}

export function coerceToolSchemas(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map(tool => {
    if (!isPlainObject(tool)) return tool;
    const result = { ...tool };
    if (isPlainObject(result.function) && "parameters" in result.function) {
      result.function = { ...result.function, parameters: coerceSchemaNumericFields(result.function.parameters) };
    }
    if (result.input_schema !== undefined) {
      result.input_schema = coerceSchemaNumericFields(result.input_schema);
    }
    if ("parameters" in result && !isPlainObject(result.function)) {
      result.parameters = coerceSchemaNumericFields(result.parameters);
    }
    return result;
  });
}

export function sanitizeToolDescription(tool) {
  if (!isPlainObject(tool)) return tool;
  const result = { ...tool };
  if (result.description === null || result.description === undefined) {
    result.description = "";
  } else if (typeof result.description !== "string") {
    result.description = String(result.description);
  }
  if (isPlainObject(result.function)) {
    const fn = { ...result.function };
    if (fn.description === null || fn.description === undefined) {
      fn.description = "";
    } else if (typeof fn.description !== "string") {
      fn.description = String(fn.description);
    }
    result.function = fn;
  }
  return result;
}

export function sanitizeToolDescriptions(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map(tool => sanitizeToolDescription(tool));
}
