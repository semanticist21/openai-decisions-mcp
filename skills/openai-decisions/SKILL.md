---
name: openai-decisions
description: Use the Decisions MCP to classify, filter, or score supplied evidence with caller-defined criteria. Useful for repeated semantic judgments and selecting relevant files before reading them in full.
---

# OpenAI Decisions

Use `decide` for several independent questions about shared evidence. Use `evaluate_batch` for independent items with the same questions. Choose the criteria, inputs, and subsequent action for the task; no fixed workflow or mandatory invocation.

- Prefer file paths over copying long content into tool arguments. Current-project files are available automatically; other roots require server configuration. Multiple project roots require an explicit authorized `root` for relative paths, or absolute paths.
- Sources are `{type:"text",text}`, `{type:"file",path,start_line?,end_line?}`, `{type:"image",path}`, or `{type:"pdf",path,pages?,mode?}`. Lines and PDF pages are one-based. Combine sources when the judgment needs several pieces of evidence.
- Questions have unique `name`, `type`, and self-contained `instructions`. `predicate` returns a probability. `choice` additionally takes `choices:[{value,description?}]`. `score` takes ordered `levels:[{label,description?}]`; indices start at zero and scores may be fractional.
- Batch input is `{items:[{id,sources}],questions,full?}`. Each item is a separate paid API request. Questions within one item share evidence but do not depend on each other's answers.
- PDF `auto` extracts text and renders textless pages. Use `visual` for layout, diagrams, tables, or scans; use `text` only when text is sufficient. A page containing some text can still have important visual content.
- Compact output is the default. Set `full:true` when the entire probability distribution matters. Preserve refusal and per-item error states; never interpret them as a negative score or approval.
- Check `coverage`: selected ranges are not evidence about an entire document. Oversized inputs fail rather than truncate. Retry only the failed IDs when appropriate, not a whole successful batch.
- Use explicit categories and observable rubric levels. Include an insufficient-evidence/other choice when appropriate. Model confidence is not factual proof; calibrate any thresholds against labeled examples.
- Use code for exact calculations and deterministic rules. Keep open-ended reasoning, explanations, edits, and action execution with the calling agent. These judgments never grant authorization.
- Calls send selected content to OpenAI and use a separate API key; ChatGPT subscriptions are not used. Keys belong in protected environment configuration, never tool arguments.

Token savings depend on what work is displaced. Avoid asking the main model to read, reproduce, and judge the same input before delegating it. This tool does not itself guarantee savings or replace tests.
