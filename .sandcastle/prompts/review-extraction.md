Based on the review you just completed, emit a structured verdict as a JSON object inside an `<output>` XML tag.

The JSON must match this schema exactly:

```json
{
  "verdict": "pass" | "changes-requested",
  "summary": "<one paragraph summarising the verdict>",
  "comments": [
    {
      "path": "<file path relative to repo root>",
      "line": <line number in the diff, as a positive integer>,
      "body": "<specific, actionable feedback>"
    }
  ]
}
```

- `verdict`: `"pass"` if all acceptance criteria are met, `"changes-requested"` otherwise.
- `summary`: A concise paragraph explaining the overall verdict.
- `comments`: Empty array `[]` for a pass. For changes-requested, list only comments for lines that appear in the diff (path + line must correspond to an actual changed line). If unsure of the exact line, omit that comment rather than guessing.

Emit **only** the `<output>` block — no prose before or after it.

<output>
{"verdict": "...", "summary": "...", "comments": [...]}
</output>
