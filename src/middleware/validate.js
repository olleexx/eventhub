import { AppError } from '../lib/errors.js';

/**
 * validate({ body, query, params }) with zod schemas. Parsed (and stripped) values replace the
 * originals, which also blocks mass assignment: unknown keys never reach services.
 */
export function validate(schemas) {
  return (req, res, next) => {
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (!result.success) {
        const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
        return next(new AppError(400, 'VALIDATION_ERROR', 'Please check the highlighted fields', details));
      }
      if (part === 'query') {
        Object.defineProperty(req, 'validatedQuery', { value: result.data, configurable: true });
      } else {
        req[part] = result.data;
      }
    }
    next();
  };
}
