---
name: dotnet-conventions
description: House conventions for C#/.NET changes — testing, naming and build commands. Use when implementing or modifying dotnet code.
---

# dotnet conventions (example)

- Build and test with `dotnet build` and `dotnet test` before committing.
- One test class per production class; name tests `Method_Scenario_Expected`.
- Prefer records for immutable data, `async`/`await` end to end, and nullable reference types enabled.
- Do not add NuGet packages without being asked.

Replace this with your team's real rules.
