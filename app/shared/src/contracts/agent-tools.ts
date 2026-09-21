import { z } from 'zod';

export const readDocumentParams = z.object({
  from_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based first line to return. Omit to read from the beginning.'),
  to_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based last line to return, inclusive. Omit to read to the end.'),
});

export const editOperation = z.object({
  old_string: z
    .string()
    .min(1)
    .describe(
      'Exact existing text to replace, copied verbatim from the document, including whitespace. ' +
        'Must appear EXACTLY ONCE in the document — include surrounding context to disambiguate ' +
        'if the text is repeated.',
    ),
  new_string: z.string().describe('Replacement text. Use an empty string to delete.'),
});
export type EditOperation = z.infer<typeof editOperation>;

export const proposeDocumentEditParams = z.object({
  summary: z
    .string()
    .min(1)
    .max(200)
    .describe('One-line description of this change, shown to the user in the review UI.'),
  operations: z
    .array(editOperation)
    .min(1)
    .max(50)
    .describe(
      'One or more replacements. They may target disjoint parts of the document; they are ' +
        'reviewed and accepted or dropped together as a single proposal.',
    ),
});

export const webSearchParams = z.object({
  query: z.string().min(1).describe('The search query.'),
});

export const webFetchParams = z.object({
  url: z.string().min(1).describe('The URL to fetch.'),
});
