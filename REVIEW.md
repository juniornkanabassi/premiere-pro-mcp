# Personal fork review

Always High: Companion process execution, writer policy, configuration and plugin installation.

Check that no caller supplies a shell command, options cannot be injected through values, unknown arguments fail before dispatch, and failed/unknown Companion jobs are never replayed automatically.

Every current Companion MCP command must appear with its exact schema under companion_. Use the existing CLI, not copied editing code. Retain grants, project checks and original error output.

Only one backend may write through one profile. Enforce at dispatch, not just discovery. Native read/write mode must not enable unsafe-script.

Tests must use disposable fake CLIs and no app windows. Live checks use a backed-up throwaway project. No real-project write is part of installing this fork.

Known gap: this policy cannot lock another MCP server, another extension or manual edits. UXP native-writer validation is separate from Companion integration.
