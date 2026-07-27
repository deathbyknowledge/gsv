---
name: image-reading
description: Read and analyze images on GSV or connected targets with img2txt. Use for captions, visual questions, OCR, structured extraction, object pointing or detection, and screenshots or image files stored on another target.
---

# Read Images

Run `img2txt` from the `gsv` target. Use `man img2txt` for current syntax.

Choose the mode based on the task:

- `caption`: Describe the image. Use `--length short|normal|long`.
- `query`: Answer a specific visual question. Requires `--prompt`.
- `ocr`: Extract text. Optionally use `--prompt` to narrow the extraction.
- `point`: Return normalized coordinates for instances of an object. Requires `--target`.
- `detect`: Return normalized bounding boxes for instances of an object. Requires `--target`.

Pass images directly using a local path, `gsv:/path`, `target:/path`, or
`[target-with-colons]:/path`. Target images stream directly and do not need to
be copied into GSV first.

For `query` and `ocr`, use `--response-format` for JSON, XML, Markdown, or CSV.
Use `--schema` with JSON when the result must have a specific structure.

Use `--reasoning --json` when query reasoning or grounding is useful.
Use `--stream` only for unstructured caption, query, or OCR text; it cannot be
combined with JSON envelopes, reasoning, or structured output.

`point` and `detect` produce JSON by default.
