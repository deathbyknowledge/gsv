export type JsonPrimitive = null | boolean | number | string;

export type JsonObject = {
  [key: string]: JsonValue;
};

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
