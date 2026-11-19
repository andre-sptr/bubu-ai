function createFallbackZod() {
  const makeChain = (validateFn = (v) => v) => {
    let isOptional = false;
    let isNullable = false;
    const refinements = [];
    const api = {
      optional() { isOptional = true; return api; },
      nullable() { isNullable = true; return api; },
      strict() { return api; },
      min() { return api; },
      max() { return api; },
      int() { return api; },
      positive() { return api; },
      uuid() { return api; },
      url() { return api; },
      datetime() { return api; },
      default() { return api; },
      refine(fn, message = 'Validation failed') {
        refinements.push({ fn, message });
        return api;
      },
      parse(val) {
        if (val === undefined) {
          if (isOptional) return undefined;
          throw new Error('Required value is undefined');
        }
        if (val === null) {
          if (isNullable) return null;
          throw new Error('Value cannot be null');
        }
        const out = validateFn(val);
        for (const r of refinements) {
          if (!r.fn(out)) throw new Error(r.message);
        }
        return out;
      }
    };
    return api;
  };

  return {
    string: () => makeChain((v) => {
      if (typeof v !== 'string') throw new Error('Expected string');
      return v;
    }),
    number: () => makeChain((v) => {
      if (typeof v !== 'number' || Number.isNaN(v)) throw new Error('Expected number');
      return v;
    }),
    boolean: () => makeChain((v) => {
      if (typeof v !== 'boolean') throw new Error('Expected boolean');
      return v;
    }),
    null: () => makeChain((v) => {
      if (v !== null) throw new Error('Expected null');
      return null;
    }),
    enum: (values) => makeChain((v) => {
      if (!values.includes(v)) throw new Error(`Expected one of: ${values.join(', ')}`);
      return v;
    }),
    array: (itemSchema) => makeChain((v) => {
      if (!Array.isArray(v)) throw new Error('Expected array');
      return itemSchema ? v.map((item) => itemSchema.parse(item)) : v;
    }),
    union: (schemas) => makeChain((v) => {
      for (const s of schemas) {
        try { return s.parse(v); } catch {}
      }
      throw new Error('Invalid union value');
    }),
    record: () => makeChain((v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected record object');
      return v;
    }),
    object: (shape = {}) => {
      let strictMode = false;
      const base = makeChain((v) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected object');
        if (strictMode) {
          for (const key of Object.keys(v)) {
            if (!Object.prototype.hasOwnProperty.call(shape, key)) {
              throw new Error(`Unrecognized key: ${key}`);
            }
          }
        }
        const out = {};
        for (const [k, schema] of Object.entries(shape)) {
          const parsed = schema.parse(v[k]);
          if (parsed !== undefined) out[k] = parsed;
        }
        return out;
      });
      const origStrict = base.strict;
      base.strict = () => {
        strictMode = true;
        return origStrict();
      };
      return base;
    }
  };
}

function loadZod() {
  try {
    return require('zod').z;
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return createFallbackZod();
    throw err;
  }
}

const z = loadZod();

module.exports = { z, loadZod, createFallbackZod };
