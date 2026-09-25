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

// ---- Todo & Parking Lot lists (012-todo-parking-lists) ----

// Bug fix: a validation failure against this enum (or its TypeBox mirror, pi/tools/list-items.ts's
// `ListNameToolParam`) reports only a generic "must be equal to constant"/"must be one of the
// allowed values" message with no clue what the accepted value(s) actually are — this description
// is the one place that can proactively tell the agent the exact literal strings, before it ever
// guesses a plausible-looking variant (`"parking-lot"`, `"Parking Lot"`) that then fails with no
// useful correction.
const listItemList = z
  .enum(['todo', 'parking_lot'])
  .describe(
    "Which list. Must be exactly one of these two literal strings: 'todo' or 'parking_lot' " +
      "(snake_case, lowercase, exactly as spelled here — not 'parking-lot', 'Parking Lot', or " +
      'any other variant).',
  );

export const listItemsParams = z.object({});

export const addListItemParams = z.object({
  list: listItemList,
  text: z.string().min(1).describe('The item text. Must not be empty or whitespace-only.'),
});

export const updateListItemParams = z.object({
  list: listItemList,
  id: z.string().describe('The item id.'),
  expected_content_hash: z
    .string()
    .describe(
      "The hash of the item's CURRENT text, as last told to you by add_list_item, a prior " +
        'update_list_item, or list_items — never a hash of the new text below.',
    ),
  text: z.string().min(1).describe('The new item text. Must not be empty or whitespace-only.'),
});

export const removeListItemParams = z.object({
  list: listItemList,
  id: z.string().describe('The item id.'),
  expected_content_hash: z
    .string()
    .describe("The hash of the item's current text, as last told to you."),
});

export const listItemToolResult = z.object({
  id: z.string(),
  list: z.enum(['todo', 'parking_lot']),
  contentHash: z.string().optional(), // absent on remove_list_item success
});
export type ListItemToolResult = z.infer<typeof listItemToolResult>;
