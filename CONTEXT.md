# TAWX Desktop

TAWX Desktop provides three modes for conversational assistance, delegated work, and code-focused tasks.

## Language

**Mode**:
The active working experience: Chat, Cowork, or Code.
_Avoid_: Tab, workspace type

**Status Line**:
A persistent, compact summary of the currently open context across every mode. It contains mode-specific Status Items within a shared structure.
_Avoid_: Footer, task bar

**Status Item**:
One interactive unit in the Status Line representing State, Environment, Model, Context, or Runtime. An item may be absent when it does not apply to the current context.
_Avoid_: Badge, widget

**State**:
The lifecycle state of the currently open conversation, task, or Cowork section.
_Avoid_: Global status, background task status

**Environment**:
The workspace and permission policy attached to the currently open Code or Cowork task.
_Avoid_: Runtime, context

**Context**:
The model context budget for the currently open conversation or task, expressed primarily as the percentage used.
_Avoid_: Workspace, application state

**Runtime**:
The execution dependency serving the current mode: the provider in Chat or the desktop runtime in Code and Cowork.
_Avoid_: Environment, task state
