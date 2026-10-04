MASTER AI ENGINEERING WORKFLOW
Universal Spec-First Development Process
Version: 1.1.0

───

PURPOSE
This document defines the mandatory engineering workflow for building software, AI systems, agents, bots, automations, internal tools, client solutions, intelligent applications, robotics systems, and other technology products.
The purpose is to eliminate:
• Random development
• Vibe-driven architecture
• AI-generated technical debt
• Uncontrolled feature expansion
• Unclear ownership
• Security shortcuts
• Unmaintainable code
• Backend-only implementations
• Missing UI workflows
• Hidden dependencies
• Uncontrolled AI autonomy
• Duplicate logic
• Architecture drift
• Documentation drift
• Repeated reinvention
• “Fix it later” engineering
• Overengineering
• Underengineering
• AI agents making unauthorized architectural decisions
The goal is not simply to produce working code.
The goal is to produce maintainable, understandable, testable, secure, observable, scalable-enough systems with clear ownership and controlled evolution.
This workflow applies whether the system is built by:
• A human
• One AI coding agent
• Multiple AI agents
• A human/AI team
• Claude Code
• Gemini
• GPT
• Cursor
• Other coding assistants
• Custom autonomous agents
AI tools are implementation assistants.
They are not automatically architects, authorities, product owners, or sources of truth.

───

CORE PHILOSOPHY
1. Specification Before Implementation
Systems are designed before they are implemented.
Requirements define behavior.
Architecture defines structure.
Contracts define interfaces.
Detailed design defines implementation boundaries.
Tasks define the work.
Code implements approved design.
Tests verify behavior.
Review verifies quality.
Documentation preserves understanding.

───

2. No Code Until Design Is Complete Enough
MASTER RULE
NO IMPLEMENTATION CODE IS WRITTEN UNTIL THE DESIGN IS COMPLETE ENOUGH FOR THE CURRENT APPROVED IMPLEMENTATION SCOPE.
This does not mean the entire five-year product must be completely designed before writing the first line of code.
It means:
• The current feature must be understood.
• Its requirements must be defined.
• Its architectural impact must be understood.
• Its relevant contracts must be defined.
• Its data requirements must be understood.
• Its security implications must be understood.
• Its UI/workflow requirements must be understood when applicable.
• Its testing strategy must be understood.
• Its task must have clear acceptance criteria.
Future functionality may remain intentionally unspecified.
Do not:
“Let's just build it and figure out the architecture later.”
Do:
“Let's design the smallest complete slice we are actually implementing, then build it.”
This prevents both:
• Premature coding
• Infinite planning

───

3. PROPORTIONAL ENGINEERING
The workflow is mandatory, but the depth of the workflow must be proportional to the change.
Do not turn a tiny low-risk change into a massive architecture exercise.
For example:
A simple visual adjustment may not require:
• A new ADR
• A database migration
• A threat model
• A new architecture document
A change involving:
• Authentication
• User permissions
• AI authority
• Persistent data
• Public APIs
• Security
• Autonomous actions
requires substantially more design and review.
Rule
Apply documentation, design, testing, and review proportional to the risk, complexity, scope, and architectural impact of the change.
This prevents the engineering workflow itself from becoming technical debt.

───

GOLDEN ENGINEERING PRINCIPLES
These principles govern every project.
1. Requirements before architecture.
2. Architecture before implementation.
3. Design before code.
4. Specs beat code.
5. Architecture beats convenience.
6. Determinism beats unnecessary ML.
7. Safety beats convenience.
8. Clarity beats speed.
9. Explicit ownership beats ambiguity.
10. Simple systems beat unnecessarily complex systems.
11. Repository structure follows architecture.
12. Architecture follows requirements.
13. Technology serves architecture.
14. AI-generated code is held to the same standards as human-written code.
15. Code must be understandable to a future human maintainer.
16. AI must not invent requirements.
17. AI must not silently redesign architecture.
18. AI must not expand its own authority.
19. Contracts are sources of truth.
20. Shared state must have explicit ownership.
21. Dependencies must flow according to architecture.
22. Circular dependencies are prohibited unless explicitly justified.
23. Persistent data requires migration and compatibility planning.
24. User-facing features require complete user workflows, not merely backend functionality.
25. Prefer vertical slices over building entire layers in isolation.
26. Every feature must be testable.
27. Every important decision must be explainable.
28. Documentation is part of the system.
29. Observability is part of production engineering.
30. Security is part of design, not a final patch.
31. Version control is mandatory.
32. Environment separation is mandatory where environments differ.
33. Do not overengineer hypothetical problems.
34. Do not postpone known structural problems under “we'll clean it later.”
35. Future expansion must not compromise current clarity.
36. The system must evolve deliberately, not accidentally.
37. Engineering rigor must be proportional to change impact.

───

MASTER DEVELOPMENT LIFECYCLE
Every project follows:
Idea
 ↓
 Vision
 ↓
 Requirements
 ↓
 User Stories & Workflows
 ↓
 Governance & Safety
 ↓
 Architecture
 ↓
 Technology Selection & Decisions
 ↓
 Contracts
 ↓
 Detailed Design
 ↓
 Service Specifications
 ↓
 Intelligence Design
 ↓
 Automation & Autonomy
 ↓
 Runtime & Entrypoint
 ↓
 Repository & Codebase Architecture
 ↓
 Roadmap
 ↓
 Tasks
 ↓
 Implementation
 ↓
 Testing
 ↓
 Review
 ↓
 Deployment
 ↓
 Project State
 ↓
 Postmortem
 ↓
 Iteration & Expansion
No stage should be casually skipped.
However, not every change requires creating or rewriting every artifact. The Change Impact Classification determines the appropriate depth.

───

PHASE 0 — PROBLEM DISCOVERY
Human-First
Before discussing frameworks, databases, AI models, APIs, or implementation:
Determine:
Problem
What problem does this solve?
Target User
Who experiences the problem?
Consequences
What happens if the problem remains unsolved?
Current Behavior
How is the problem solved today?
Value
Why would someone use this system?
Success
What measurable outcome would prove the system works?
Simplest Valuable Version
What is the smallest version that provides real value?
Rules
Do not begin with:
• “What framework should we use?”
• “What AI model should we use?”
• “Should this be microservices?”
• “Let's build an agent.”
• “Let's use a vector database.”
Technology comes later.
Deliverable
docs/idea.md
Required sections:
• Project Name
• Problem Statement
• Target User
• Current Problem/Alternative
• Core Value Proposition
• Consequences of Not Solving
• Success Criteria
• MVP Definition
• Explicit Non-Solutions

───

PHASE 1 — VISION & SCOPE LOCK
Define what the product is.
Mission
What is this product trying to accomplish?
Users
Who benefits?
Core Features
What belongs in the MVP?
Future Features
What is intentionally excluded?
Non-Goals
What will this system explicitly NOT do?
Success Metrics
How will success be measured?
Scope Boundary
Define:
• MVP
• Post-MVP
• Future
• Explicitly excluded
Rule
The system cannot continuously grow during implementation merely because an AI agent discovers another interesting idea.
New ideas become future scope unless formally approved.
Deliverable
docs/vision.md

───

PHASE 2 — REQUIREMENTS
Define what the system must do.
Functional Requirements
Describe required behaviors.
Examples:
• User registration
• Authentication
• Data creation
• Data retrieval
• AI interaction
• Notifications
• Payments
• Search
• File processing
Only include requirements actually justified by the project.

───

Non-Functional Requirements
Define:
Performance
• Response-time expectations
• Throughput
• Resource limits
Security
• Authentication
• Authorization
• Encryption
• Secrets
• Input validation
• Abuse prevention
Scalability
• Expected users
• Expected data
• Growth assumptions
Reliability
• Failure handling
• Recovery
• Availability expectations
Accessibility
• Keyboard access
• Screen readers
• Contrast
• Responsive behavior
• Assistive technology
Maintainability
• Code organization
• Documentation
• Testing
• Observability

───

Constraints
Document:
• Budget
• Hosting
• Third-party services
• Licensing
• Hardware
• APIs
• Vendor restrictions
• Model availability
• Device constraints
• Regulatory requirements
Deliverable
docs/requirements.md

───

PHASE 3 — USER STORIES & WORKFLOWS
Translate requirements into user behavior.
Format:
As a user,
 I want to ______
 so that ______.
Also define:
• Primary workflows
• Alternate workflows
• Error workflows
• Empty states
• Loading states
• Permission-denied states
• Recovery workflows
• Administrative workflows
For AI systems also define:
• What the user asks
• What the system understands
• What the system may do
• What requires approval
• What it must refuse
• What happens when confidence is low
• What happens when tools fail
Deliverable
docs/user-stories.md

───

PHASE 4 — GOVERNANCE, SAFETY & AUTHORITY
This phase defines what the system is allowed to do.
Authority Model
Define:
• User authority
• Administrator authority
• AI authority
• Tool authority
• Service authority
• System authority
AI authority must always be explicitly bounded.

───

Allowed Actions
Document what the system may do.

───

Forbidden Actions
Document what the system must never do.

───

Approval Requirements
Define actions requiring:
• User approval
• Administrator approval
• Human review
• Additional authentication

───

Safety Overrides
Safety controls override convenience.

───

Escalation
Define what happens when:
• AI is uncertain
• A tool fails
• A request is ambiguous
• A dangerous action is requested
• Authorization is unclear
• Data conflicts
• Policy is violated

───

Core AI Safety Rule
AI must never silently expand its own authority.
If an AI agent believes it needs additional permissions:
1. Stop.
2. Explain what permission is needed.
3. Explain why.
4. Request authorization.
5. Continue only after approval.
A governance violation must abort or safely stop the operation.
Deliverable
docs/governance.md

───

PHASE 5 — SYSTEM ARCHITECTURE
No implementation.
Design the system.
System Overview
Explain:
• Major components
• Responsibilities
• Communication
• Data flow
• External systems

───

Responsibility Boundaries
Each service/module should have a clear responsibility.
Avoid components that become “god modules.”

───

Data Flow
Describe:
Input → Processing → Storage → Output
Include:
• User data
• AI data
• External data
• Events
• State transitions

───

Ownership
Every major piece of state must have an owner.
Avoid uncontrolled shared mutable state.
Shared state is allowed when intentionally designed, such as:
• Databases
• Caches
• Sessions
• Authentication state
• Application state
• Event systems
But ownership and mutation rules must be explicit.

───

Service Boundaries
Define:
• Responsibilities
• Inputs
• Outputs
• Dependencies
• Failure boundaries
Do not create services merely because “microservices are scalable.”

───

Dependency Direction
Dependencies must flow according to architecture.
Rules:
• Higher-level policy should not accidentally depend on low-level implementation details.
• Infrastructure should not dictate business logic.
• UI should not contain core business rules.
• Business logic should not depend directly on UI.
• Circular dependencies are prohibited unless explicitly justified and documented.
• Dependencies should be introduced deliberately.

───

Technical Debt Prevention
Identify:
• Likely shortcuts
• Architectural risks
• Scaling risks
• Security risks
• Vendor lock-in
• Data migration risks
• AI-specific risks
Deliverable
docs/architecture.md

───

PHASE 6 — TECHNOLOGY SELECTION & ARCHITECTURE DECISIONS
Technology is selected after understanding the requirements and architecture.
Do not allow the coding agent to casually choose technologies because:
• It prefers them
• They are trendy
• They are familiar
• The user mentioned them casually
• They are easiest for generated code

───

Technology Selection
Evaluate where applicable:
Frontend
Examples:
• React
• Vue
• Svelte
• Vanilla
• Mobile frameworks
• Electron
Backend
Examples:
• Node
• Python
• Go
• Rust
• Other appropriate technologies
Database
Examples:
• PostgreSQL
• SQLite
• MongoDB
• Redis
• Specialized storage
AI
Define:
• Model provider
• Model selection
• Embeddings
• Tool calling
• Agent framework if needed
• Local vs cloud inference
Authentication
Define authentication technology.
Hosting
Define:
• Development
• Staging
• Production
Testing
Define:
• Unit framework
• Integration framework
• E2E framework
Build Tooling
Examples:
• Vite
• Package manager
• Bundler
• Compiler
Deployment
Define:
• CI/CD
• Containers
• Hosting
• Infrastructure

───

Technology Decision Rule
Every major technology choice should have:
• Requirement it satisfies
• Alternatives considered
• Reason selected
• Tradeoffs
• Consequences

───

Architecture Decision Records
Important technical decisions should be documented as ADRs.
Location:
docs/decisions/
Examples:
text
docs/decisions/
├── ADR-001-frontend-framework.md
├── ADR-002-database.md
├── ADR-003-authentication.md
├── ADR-004-ai-provider.md
└── ADR-005-hosting.md

Each ADR contains:
• Decision
• Context
• Problem
• Alternatives
• Why chosen
• Tradeoffs
• Consequences
• Date
• Status
ADRs exist so future maintainers—and the user—can understand why the system was built this way.

───

Important Rule
The master workflow remains technology-agnostic.
For example:
Vite is not part of this universal workflow.
If a project chooses Vite, that decision belongs in that project's technology selection and ADR documentation.
The same workflow must work for:
• React
• Vue
• Svelte
• Python
• Go
• Rust
• Electron
• Mobile
• Robotics
• Serverless
• Other architectures

───

PHASE 7 — SYSTEM CONTRACTS
Contracts define interfaces between components.
Examples:
• API contracts
• Tool contracts
• Event contracts
• Data schemas
• AI tool interfaces
• Service interfaces

───

Contract Rules
Contracts are stable sources of truth.
Code conforms to contracts.
Contracts do not silently change because implementation became inconvenient.
However, contracts are not absolutely immutable forever.
A breaking change requires:
1. Explicit review
2. Versioning when appropriate
3. Migration planning
4. Compatibility analysis
5. Documentation
6. Testing

───

Contract Examples
API
text
POST /users
GET /users/:id

Tool
text
search_memory(query)

Event
text
UserCreated

Data
text
User
Memory
Conversation
Task

Contracts must define:
• Inputs
• Outputs
• Validation
• Errors
• Permissions
• Versioning

───

PHASE 8 — DETAILED SYSTEM DESIGN
Architecture explains what exists and why.
Detailed design explains how the approved current scope will work.
This phase must be complete enough before implementation begins.

───

Required Design Areas
AI Agents
Define:
• Agent responsibilities
• Agent inputs
• Agent outputs
• Available tools
• Permissions
• Memory access
• Decision boundaries
• Escalation
• Failure behavior

───

Security Design
Define:
• Authentication
• Authorization
• Secret handling
• Input validation
• Rate limiting
• Data isolation
• Threat surfaces
• Abuse prevention

───

Memory Architecture
Define:
• Short-term memory
• Long-term memory
• User memory
• System memory
• Retrieval
• Storage
• Forgetting/deletion
• Memory permissions
• Memory provenance

───

Data Model
Define:
• Entities
• Relationships
• Identifiers
• Constraints
• Indexes
• Lifecycle
• Ownership

───

Integrations
Define:
• External services
• APIs
• Authentication
• Failure handling
• Rate limits
• Retry behavior
• Vendor dependencies

───

UI/UX
For user-facing systems define:
• Screens
• Components
• Navigation
• User flows
• Responsive behavior
• Loading states
• Empty states
• Error states
• Permission states
• Accessibility

───

Workflows
Define important state transitions.
Where appropriate, use:
• State machines
• Event models
• Sequence diagrams
• Flow diagrams

───

API Contracts
Define:
• Endpoints
• Request schemas
• Response schemas
• Errors
• Authentication
• Authorization
• Versioning

───

Testing Strategy
Define:
• Unit tests
• Integration tests
• E2E tests
• Error tests
• Edge cases
• AI evaluation
• Security testing
• Performance testing

───

Threat Model
When appropriate, identify:
• Assets
• Threat actors
• Attack surfaces
• Abuse cases
• Security controls
• Residual risks

───

PHASE 9 — SERVICE SPECIFICATIONS
Every significant service/module should have a clear specification.
A service specification should define:
• Purpose
• Responsibility
• Inputs
• Outputs
• Dependencies
• Tool usage
• Failure modes
• Security rules
• Data access
• Logging
• Testing requirements

───

Deterministic-First Rule
Use deterministic logic when deterministic logic is sufficient.
AI/ML should refine or assist decisions when appropriate.
AI should not replace simple deterministic logic merely because AI is available.

───

PHASE 10 — INTELLIGENCE DESIGN
This phase applies to AI-powered systems.
Define:
• Reasoning flows
• Ranking
• Classification
• Recommendations
• Retrieval
• Context construction
• Feedback loops
• Evaluation
• Confidence handling

───

Intelligence Boundary
AI intelligence cannot automatically:
• Execute arbitrary actions
• Invent authoritative data
• Modify architecture
• Expand permissions
• Redefine requirements
AI reasoning produces:
• Analysis
• Recommendations
• Classifications
• Proposed actions
Execution must follow the authority model.

───

PHASE 11 — AUTOMATION & AUTONOMY
Automation comes after intelligence and governance.
For each automated action define:
• Trigger
• Preconditions
• Permission
• Approval requirement
• Action
• Result
• Logging
• Failure behavior
• Rollback
• Revocation

───

Autonomous System Rules
Automation should be:
• Explicitly authorized
• Reversible where possible
• Logged
• Observable
• Revocable
• Bounded
Autonomy must never be equivalent to unlimited authority.

───

PHASE 12 — RUNTIME & ENTRYPOINT
Define how the system starts and runs.
Examples:
• Web application
• CLI
• Desktop application
• API server
• Worker
• Mobile application
• Robot controller
• Embedded runtime
The runtime entrypoint should primarily handle:
• Startup
• Configuration
• Dependency initialization
• Shutdown
• Routing/orchestration
Business logic should not be dumped into the entrypoint.

───

PHASE 13 — REPOSITORY & CODEBASE ARCHITECTURE
The repository is part of the architecture.
Core Rule
Repository structure follows architecture, not imagination.
Do not create every possible folder on day one.
Only create architectural boundaries that are justified by the current system.
Do not create speculative:
• Payment services
• Authentication services
• Notification systems
• Microservices
• AI subsystems
• Databases
• Event buses
unless the architecture requires them.

───

STANDARD REPOSITORY FOUNDATION
When applicable:
text
project/
│
├── docs/
├── src/
├── tests/
├── scripts/
├── public/
├── .github/
│
├── README.md
├── CHANGELOG.md
├── ROADMAP.md
├── TASKS.md
├── PROJECT_STATE.md
├── CLAUDE.md
├── GEMINI.md
├── ARCHITECT.md
├── .gitignore
├── .env.example
└── package/config files

Not every project requires every item immediately.
The architecture determines the final structure.

───

DOCUMENTATION STRUCTURE
Recommended:
text
docs/
├── idea.md
├── vision.md
├── requirements.md
├── user-stories.md
├── governance.md
├── architecture.md
├── detailed-design.md
├── roadmap.md
├── testing-strategy.md
├── threat-model.md
├── decisions/
│   ├── ADR-001-*.md
│   ├── ADR-002-*.md
│   └── ...
└── services/
    ├── service-a.md
    ├── service-b.md
    └── ...

Only create documents that apply.

───

SOURCE STRUCTURE
The exact structure depends on the technology.
A frontend application may use:
text
src/
├── app/
├── components/
├── features/
├── services/
├── data/
├── hooks/
├── lib/
├── types/
├── config/
└── state/

A backend may use:
text
src/
├── api/
├── domain/
├── services/
├── repositories/
├── models/
├── infrastructure/
├── config/
└── types/

The project may use a completely different structure if its architecture requires it.

───

UI / BUSINESS LOGIC SEPARATION
For user-facing applications:
UI should handle:
• Rendering
• User interaction
• Presentation
• Navigation
Business logic should live outside presentation components where practical.
Do not allow important business rules to become buried inside UI components.

───

API / DATA SEPARATION
Do not tightly couple UI directly to database implementation.
Use appropriate boundaries between:
• UI
• Application logic
• Services
• APIs
• Repositories
• Infrastructure
The exact layering depends on architecture.

───

FEATURE ORGANIZATION
When appropriate, organize around features rather than creating giant global folders.
A feature may contain:
text
feature/
├── components/
├── services/
├── hooks/
├── types/
└── tests/

Use this only when it improves ownership and maintainability.

───

FILE SIZE
Preferred maximum:
Approximately 300 lines per file.
This is a guideline, not a mathematical law.
A file exceeding the guideline should trigger review.

───

FUNCTION SIZE
Preferred maximum:
Approximately 50 lines per function.
Large functions should be reviewed for:
• Multiple responsibilities
• Hidden complexity
• Poor separation
• Reusable logic
Do not split functions artificially just to satisfy a number.

───

CODE QUALITY
Use:
• Strict typing
• Clear naming
• Small focused modules
• Composition over inheritance
• SOLID principles
• DRY principles
• Separation of concerns
Avoid:
• Duplicate logic
• Dead code
• Temporary hacks
• Silent failures
• Magic values
• Hardcoded secrets
• Hidden global state
• Unnecessary abstractions

───

DEPENDENCY RULES
Every dependency should have a reason.
Before adding a package ask:
1. Is it actually necessary?
2. Can existing project code solve it cleanly?
3. What does it add?
4. What maintenance burden does it create?
5. Is it secure?
6. Is it actively maintained?
7. Does it create vendor lock-in?
8. Does it violate architecture?
Do not add dependencies simply because an AI agent finds them convenient.

───

ENVIRONMENT & CONFIGURATION
Separate environments when applicable:
• Development
• Test
• Staging
• Production
Rules:
• Environment-specific configuration must be separated from business logic.
• Secrets must not be committed.
• .env.example should document required variables without exposing secrets.
• Development credentials must not accidentally be used in production.
• Production configuration must be explicit.
• Environment differences must be documented.

───

TEST ORGANIZATION
Typical structure:
text
tests/
├── unit/
├── integration/
├── e2e/
├── security/
└── fixtures/

Exact organization depends on the project.

───

REPOSITORY CLEANLINESS
Do not commit:
• Secrets
• API keys
• Passwords
• Temporary files
• Build artifacts
• Personal data
• Debug dumps
• Unused assets
• Dead experimental code

───

DOCUMENTATION / CODE AGREEMENT
If architecture changes:
Update docs/architecture.md.
If requirements change:
Update docs/requirements.md.
If technical decisions change:
Update or create an ADR.
If project status changes:
Update PROJECT_STATE.md.
Documentation cannot intentionally describe a system that no longer exists.

───

PHASE 14 — ROADMAP
Break development into meaningful phases.
Example:
text
Phase 1 — Foundation
Phase 2 — Authentication
Phase 3 — Core Features
Phase 4 — AI Integration
Phase 5 — Automation
Phase 6 — Optimization
Phase 7 — Deployment

Each phase must have:
• Objective
• Scope
• Dependencies
• Deliverables
• Exit criteria

───

PHASE 15 — TASK GENERATION
Tasks must be:
• Small
• Specific
• Independently testable
• Clearly scoped
• Less than approximately 4 hours when practical
• Attached to a requirement
• Attached to an architectural area
• Equipped with acceptance criteria
Example:
text
Create user table

Acceptance criteria:
- Schema exists
- Required fields exist
- Constraints exist
- Migration works
- Tests pass


───

VERTICAL-SLICE DEVELOPMENT
Prefer complete small slices over building enormous layers separately.
Example:
text
UI
 ↓
Application Logic
 ↓
API
 ↓
Service
 ↓
Database
 ↓
Response
 ↓
UI Update
 ↓
Tests

A vertical slice should prove that the entire relevant workflow works.
This prevents:
“The backend is finished but the actual application doesn't work for the user.”

───

USER-FACING FEATURE COMPLETENESS
A user-facing feature is not complete merely because:
• The API works.
• The database works.
• The AI works.
• The backend test passes.
A complete user-facing feature includes, when applicable:
• UI
• User workflow
• Loading state
• Empty state
• Error state
• Permission state
• Responsive behavior
• Accessibility
• Backend/service integration
• Tests

───

PHASE 16 — IMPLEMENTATION
Implementation begins only after the relevant design is approved.
Every implementation task must:
1. Read architecture.md.
2. Read requirements.md.
3. Read relevant detailed design.
4. Read relevant ADRs.
5. Read PROJECT_STATE.md.
6. Read the current task.
7. Verify dependencies.
8. Verify contracts.
9. Implement only approved scope.
10. Add/update tests.
11. Update documentation when required.
12. Update PROJECT_STATE.md.

───

IMPLEMENTATION PROHIBITIONS
The Builder must not:
• Invent requirements
• Expand scope
• Redesign architecture silently
• Add speculative systems
• Add unnecessary dependencies
• Skip tests
• Ignore contracts
• Ignore security
• Hide errors
• Create temporary hacks
• Modify permissions without approval
• Create undocumented architectural changes

───

AI ARCHITECTURE CHANGE CONTROL
If an implementation agent discovers a better architecture:
It must not silently change the architecture.
Instead report:
Proposed Change
What should change?
Reason
Why?
Impact
What existing components are affected?
Risks
What could break?
Alternatives
What other options exist?
Recommendation
What should be done?
Then:
Architecture review → Decision → ADR/update → Implementation
AI agents are not allowed to become accidental architects.

───

PHASE 17 — TESTING
Every feature requires appropriate testing.
Unit Tests
Test isolated logic.
Integration Tests
Test component/service interactions when applicable.
End-to-End Tests
Test important user workflows when applicable.
Error Handling Tests
Test:
• Invalid input
• Network failure
• Database failure
• AI failure
• Tool failure
• Authorization failure
• Timeout
• Rate limiting
Edge Cases
Test:
• Empty data
• Large data
• Missing data
• Duplicate data
• Boundary values
• Unexpected states
AI Testing
Where applicable:
• Prompt behavior
• Tool selection
• Retrieval quality
• Hallucination resistance
• Permission boundaries
• Refusal behavior
• Regression evaluation
• Output validation

───

PHASE 18 — REVIEW
Review must examine more than whether the code “works.”
Code Review
Check:
• Correctness
• Architecture
• Maintainability
• Readability
• Duplication
• Dependencies
• Error handling
• Tests
Security Review
Check:
• Authentication
• Authorization
• Secrets
• Injection
• Data exposure
• Tool permissions
• AI prompt/tool abuse
• Unsafe automation
Performance Review
Check:
• Unnecessary queries
• Expensive operations
• Memory usage
• Network calls
• AI costs
• Latency
Architecture Review
Check:
• Boundaries
• Dependencies
• Contracts
• State ownership
• Scalability
• Technical debt

───

PHASE 19 — DEPLOYMENT
Deployment must be deliberate.
Define:
• Build process
• Environment
• Configuration
• Secrets
• Database migrations
• Rollback
• Monitoring
• Logging
• Health checks
• Failure recovery

───

MIGRATIONS & BACKWARD COMPATIBILITY
Whenever changes affect persistent or externally consumed structures, determine:
• Does existing data still work?
• Does existing API usage still work?
• Do existing clients still work?
• Is migration required?
• Is rollback possible?
• Is compatibility required?
• Does memory need migration?
• Does schema versioning need to change?
Applicable systems should use:
• Database migrations
• Schema versioning
• API versioning
• Data migration scripts
• Compatibility layers
Do not casually change persistent structures without considering existing data.

───

OBSERVABILITY
Production systems must be observable at a level appropriate to their complexity.
Potential observability includes:
Logs
• Errors
• Important events
• Security events
• Tool execution
Metrics
• Latency
• Throughput
• Failure rates
• Resource usage
• AI costs
• Token usage
Tracing
Where appropriate:
• Request flow
• Service calls
• Tool calls
• External integrations
AI Observability
Where appropriate:
• Model used
• Model version
• Request metadata
• Tool calls
• Latency
• Token usage
• Errors
• Evaluation results
Do not automatically build an enterprise observability platform for a tiny MVP.
Design enough visibility to diagnose the system appropriately.

───

AUDITABILITY
Important actions should be traceable when appropriate.
Examples:
• Authentication events
• Permission changes
• AI tool executions
• Automated actions
• Financial operations
• Administrative actions
• Data deletion
• Security events

───

AI MEMORY SOURCE OF TRUTH
AI memory is not automatically truth.
The system must distinguish:
text
Authoritative Data
        ↓
Stored Memory
        ↓
Retrieved Context
        ↓
AI Reasoning
        ↓
Recommendation / Proposed Action
        ↓
Authorized Action


───

Authority Hierarchy
1. Authoritative Data
Examples:
• Verified user profile
• Database record
• Official transaction
• Explicit user instruction
2. Stored Memory
Previously saved information.
3. Retrieved Context
Information retrieved for the current task.
4. AI Reasoning
AI interpretation or inference.
5. Recommendation
What the AI believes should happen.
6. Action
Only occurs when authorized.

───

Critical Rule
AI inference must never silently become authoritative data.
Memory must include provenance where appropriate.
The system should know:
• Where the information came from
• When it was stored
• Whether it was user-provided
• Whether it was inferred
• Whether it was verified
• Whether it may be stale

───

PHASE 20 — PROJECT STATE
Every active project maintains:
PROJECT_STATE.md
Required format:
text
Current Phase:

Current Sprint:

Completed:

In Progress:

Blocked:

Next Tasks:

Known Issues:

Technical Debt:

Last Updated:

This allows humans and AI agents to understand the current state without guessing.

───

GIT & VERSION CONTROL
Git is mandatory for software projects unless there is a documented reason otherwise.
Use:
• Meaningful commits
• Feature branches when appropriate
• Pull requests where appropriate
• Tags/releases
• Revertable history
Avoid:
• final
• final-v2
• final-v2-real
• Giant unexplained commits
Commit messages should explain meaningful changes.
Never commit:
• Secrets
• Credentials
• Private keys
• Production configuration containing secrets

───

CHANGE IMPACT CLASSIFICATION
Every proposed change must be classified before implementation.
The purpose is to determine how much design, documentation, testing, and review the change requires.
Do not treat every change as equally risky.

───

LEVEL 1 — LOCAL IMPLEMENTATION CHANGE
A Level 1 change does not meaningfully affect architecture, contracts, security, persistent data, or user requirements.
Examples:
• Fixing a typo
• Adjusting spacing
• Renaming a local variable
• Improving a local function
• Correcting an isolated UI styling issue
• Refactoring internal code without changing behavior
Required
• Appropriate task
• Implementation
• Relevant tests
• Normal review
No architecture update is normally required.

───

LEVEL 2 — FEATURE CHANGE
A Level 2 change introduces or modifies user-visible behavior but remains within the existing architecture.
Examples:
• Adding a new UI feature
• Adding a search filter
• Adding a new user workflow
• Adding a new non-breaking service capability
• Adding a new screen using existing infrastructure
Required
• Requirement/user-story update if necessary
• Relevant design
• Task
• Implementation
• Tests
• UI completion when applicable
• Documentation update where necessary
• Project state update
• Review
Architecture changes are not normally required unless the feature exposes a limitation.

───

LEVEL 3 — ARCHITECTURE / DATA / CONTRACT CHANGE
A Level 3 change affects the structural behavior of the system.
Examples:
• Database schema changes
• New service boundaries
• New external integrations
• API contract changes
• New persistent data
• Memory architecture changes
• Dependency-direction changes
• Major repository restructuring
• Introducing a new infrastructure component
Required
• Impact analysis
• Architecture review
• Detailed design
• Contract review
• Migration/compatibility analysis where applicable
• ADR update or new ADR
• Testing strategy update where necessary
• Implementation
• Full review
• Documentation update
• Project state update

───

LEVEL 4 — SECURITY / AUTHORITY / PRODUCT-DIRECTION CHANGE
A Level 4 change can materially alter what the system is allowed to do, who controls it, or what the product fundamentally is.
Examples:
• Increasing AI permissions
• Adding autonomous actions
• Changing authentication architecture
• Changing authorization rules
• Handling new sensitive data
• Changing core security boundaries
• Changing the product's fundamental purpose
• Major platform migration
• Giving an agent access to new external systems
• Changing authoritative data sources
Required
• Governance review
• Security review
• Architecture review
• Threat-model review where applicable
• Requirements review
• Detailed design
• Contract review
• ADR
• Migration/compatibility analysis
• Explicit approval
• Comprehensive testing
• Observability/auditability review
• Implementation
• Reviewer approval
• Documentation update
• Project state update
AI agents must never autonomously approve Level 4 changes.

───

CHANGE IMPACT ESCALATION RULE
If uncertain between two levels:
Choose the higher level.
If implementation discovers that a change is more impactful than originally classified:
Stop implementation at the architectural boundary.
Then:
1. Reclassify the change.
2. Perform the required design/review.
3. Update documentation.
4. Resume implementation only after approval.

───

CHANGE IMPACT DECISION QUESTIONS
Before implementing a change, ask:
1. Does this change user-visible behavior?
2. Does it change requirements?
3. Does it change architecture?
4. Does it change a contract?
5. Does it change persistent data?
6. Does it affect existing clients?
7. Does it introduce a dependency?
8. Does it change authentication?
9. Does it change authorization?
10. Does it increase AI authority?
11. Does it introduce new external integrations?
12. Does it affect security?
13. Does it affect memory/source-of-truth behavior?
14. Does it require migration?
15. Does it change deployment?
16. Does it change observability requirements?
The answers determine the appropriate change level.

───

PHASE 21 — ITERATION & EXPANSION
New features do not jump directly into implementation.
They restart the appropriate design process.
At minimum:
Scope → Requirements → Architecture impact → Design → Task → Implementation → Testing → Review
If a feature changes architecture:
Update architecture + ADR.
If a feature changes requirements:
Update requirements.
If a feature changes contracts:
Review compatibility/versioning.
If a feature changes security:
Review governance/security.

───

NO HOTFIX ARCHITECTURE
A temporary fix may be acceptable only when necessary and explicitly documented.
Avoid:
“We'll clean it up later.”
If a shortcut introduces technical debt:
Document:
• Why
• What debt exists
• Impact
• Required cleanup
• Owner/task
Known technical debt must not become invisible technical debt.

───

ANTI-OVERENGINEERING RULE
Do not build complexity for hypothetical problems.
Avoid unnecessary:
• Microservices
• Event buses
• Distributed systems
• AI agents
• Databases
• Abstraction layers
• Infrastructure
unless requirements justify them.
At the same time:
Do not deliberately create obviously bad architecture with:
“We'll fix it later.”
The target is:
The simplest architecture that correctly satisfies current requirements while supporting credible near-term growth.

───

ANTI-REFACTORING RULE
Do not perform large refactors merely because the code could theoretically be “cleaner.”
Refactor when:
• Requirements demand it
• Architecture requires it
• Duplication creates real maintenance cost
• Performance requires it
• Security requires it
• The current design blocks necessary features
• Technical debt has become materially harmful
Every refactor should have a reason.

───

AI AGENT OPERATING MODEL
AI agents are divided into responsibilities.

───

ARCHITECT AGENT
Responsibilities:
• Requirements interpretation
• System architecture
• Technical decisions
• Architecture reviews
• Risk analysis
• Dependency analysis
• Design documentation
• ADR creation/review
The Architect Agent:
DOES NOT WRITE IMPLEMENTATION CODE.
It may provide pseudocode or design examples where necessary, but its role is architecture.

───

BUILDER AGENT
Responsibilities:
• Implementation
• Refactoring
• Tests
• Documentation
• Bug fixes
• Feature development
The Builder:
• Follows architecture
• Follows requirements
• Follows contracts
• Follows tasks
• Does not invent scope

───

REVIEWER AGENT
Responsibilities:
• Code review
• Security review
• Performance review
• Architecture review
• Maintainability review
• Testing review
• Documentation review
The Reviewer must reject:
• Architecture violations
• Security shortcuts
• Missing tests
• Unnecessary complexity
• Scope creep
• Silent failures
• Undocumented architectural changes

───

AGENT HANDOFF RULES
Each agent should receive enough context to perform its role.
Minimum implementation context:
• Requirements
• Architecture
• Detailed design
• Relevant contracts
• Relevant ADRs
• Current task
• Project state
Agents must not rely on undocumented assumptions.

───

LEARNING-FIRST ENGINEERING
The system is designed not only to produce code but to help the human owner understand the system over time.
AI-generated code must be explainable.
When appropriate, agents should explain:
• What was built
• Why it was built
• Which architectural boundary it belongs to
• What dependencies it uses
• What assumptions were made
• What tests verify it
• What could fail
• What future changes might affect it
The goal is:
AI accelerates implementation without permanently replacing human understanding.
The human should progressively become capable of:
• Reading the architecture
• Understanding the repository
• Reading code
• Debugging
• Evaluating AI-generated code
• Making technical decisions
• Reviewing agents
• Eventually implementing independently where desired

───

AI CODING RULE
AI-generated code is not exempt from engineering standards.
Treat AI-generated code exactly like code written by a human developer.
It must pass:
• Architecture review
• Testing
• Security review
• Maintainability review
• Documentation requirements

───

NO VIBE CODING WITHOUT GUARDRAILS
AI-assisted rapid development is allowed.
Uncontrolled development is not.
The workflow is:
text
Understand
↓
Design
↓
Specify
↓
Classify Change
↓
Task
↓
AI Implementation
↓
Inspect
↓
Test
↓
Review
↓
Document

Not:
text
Prompt AI
↓
Generate 10,000 lines
↓
Hope it works


───

CHANGE CONTROL
Changes must be classified using the Change Impact Classification system.
Minor
Equivalent to Level 1.
Does not affect:
• Architecture
• Contracts
• Security
• Requirements
• Persistent data
Can usually be handled within the current task.

───

Significant
Usually Level 2 or Level 3.
May affect:
• Features
• Architecture
• Data model
• API
• Security
• External integrations
• AI authority
• User workflows
Requires the appropriate level of design review.

───

Major
Usually Level 4.
Changes:
• Product direction
• Core architecture
• Data ownership
• Authority model
• Major contracts
• Security foundation
• Technology foundation
Requires formal architecture/product/governance review.

───

DEFINITION OF DONE
A feature is complete only when applicable:
• [ ] Requirement satisfied
• [ ] User story satisfied
• [ ] Change impact classified
• [ ] Architecture followed
• [ ] Contracts followed
• [ ] UI implemented if applicable
• [ ] Loading states handled
• [ ] Empty states handled
• [ ] Error states handled
• [ ] Permission states handled
• [ ] Accessibility considered
• [ ] Unit tests added
• [ ] Integration tests added when applicable
• [ ] E2E tests added when applicable
• [ ] Error handling tested
• [ ] Edge cases tested
• [ ] Security reviewed
• [ ] Performance considered
• [ ] Dependencies reviewed
• [ ] Observability added where appropriate
• [ ] Documentation updated
• [ ] ADR updated if required
• [ ] Migration strategy addressed if required
• [ ] No unnecessary dependencies
• [ ] No architecture violations
• [ ] No secrets committed
• [ ] No dead code
• [ ] No silent failures
• [ ] No unexplained technical debt
• [ ] Project state updated
• [ ] Reviewer approved

───

PULL REQUEST CHECKLIST
Before merging:
• [ ] Code reviewed
• [ ] Tests passing
• [ ] Documentation updated
• [ ] Requirements satisfied
• [ ] Change impact classified
• [ ] Architecture followed
• [ ] No duplicate logic
• [ ] No architecture violations
• [ ] No security issues
• [ ] No linting errors
• [ ] No failing builds
• [ ] No unauthorized dependencies
• [ ] No secrets
• [ ] Error handling verified
• [ ] Edge cases verified
• [ ] Migration reviewed if applicable
• [ ] Observability reviewed if applicable
• [ ] Project state updated

───

POSTMORTEM
After major milestones, conduct a postmortem.
Ask:
What went well?
What failed?
What caused delays?
What architectural problems appeared?
What technical debt was created?
What should have been designed earlier?
What should be automated?
What should become a workflow guardrail?
What should be added to the project template?
What should future AI agents be instructed to avoid?
Did the workflow itself create unnecessary overhead?
Was the change-impact classification appropriate?
Every major mistake should improve the engineering system.

───

TECHNICAL DEBT POLICY
Technical debt must be:
• Visible
• Documented
• Classified
• Prioritized
Categories:
• Low
• Medium
• High
• Critical
Never hide technical debt merely because the application currently works.

───

SECURITY MASTER RULE
Security is designed before implementation.
Never:
• Hardcode secrets
• Trust user input
• Assume AI output is safe
• Give AI unnecessary permissions
• Allow unrestricted tool access
• Store sensitive data without justification
• Log secrets
• Expose internal errors unnecessarily
Security requirements apply to:
• UI
• APIs
• Databases
• AI models
• Tools
• Agents
• Memory
• Automation
• Infrastructure

───

SECURITY REALISM & OBJECTIVES
Security cannot guarantee that nobody will ever be hacked.
The engineering objective is to:
• Minimize attack surface
• Prevent attacks proactively through design and defense-in-depth
• Limit privileges according to the principle of least privilege
• Detect attacks and suspicious activity early
• Contain damage when a breach or failure occurs
• Protect data integrity, confidentiality, and availability
• Recover safely, cleanly, and reliably

───

SYSTEM COMPLETENESS GATE (PRE-IMPLEMENTATION EVALUATION)
MASTER RULE
NO IMPLEMENTATION PROCEEDS UNTIL THE SYSTEM COMPLETENESS GATE IS SATISFIED.
During the design phase, every project must evaluate every relevant engineering category across:
1. Architecture & Middleware
2. Security & Abuse Defense
3. AI-Specific Safety & Governance
4. Product & Platform Completeness
5. Reliability & Operations
6. Data Governance & Privacy

MANDATORY N/A JUSTIFICATION RULE:
Every category must be formally considered.
If any category or control does not apply to a specific project, it must be explicitly marked N/A with written architectural justification in the project specification (e.g., in docs/system-completeness.md).
Silence, assumption, or casual omission is strictly prohibited.

ANTI-OVERENGINEERING BALANCE:
Every category must be evaluated, but only project-appropriate controls and infrastructure should be implemented.
Avoid speculative technology, unnecessary microservices, unneeded third-party vendors, or premature complexity.
The goal is intentional, justified, and proportional engineering.

───

SECURITY, ABUSE DEFENSE & MIDDLEWARE ARCHITECTURE
During design, every project must evaluate and define its applicable security and middleware architecture:

Network, CDN & Perimeter:
• Reverse proxy and CDN considerations
• Web Application Firewall (WAF) requirements
• API Gateway routing, authentication offloading, and TLS termination
• Infrastructure isolation and production environment separation

Security Middleware & HTTP Defense:
• Security headers: Content-Security-Policy (CSP), Strict-Transport-Security (HSTS), X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy
• Cross-Origin Resource Sharing (CORS) policies: explicit origin allowlists; never use wildcard origins with credentials
• Cross-Site Request Forgery (CSRF) protection where applicable (SameSite cookies, CSRF tokens)
• Request IDs: unique correlation IDs attached to every incoming request for distributed tracing and audit logs

Traffic Control & Abuse Defense:
• Rate limiting and throttling per IP, authenticated user, and sensitive endpoint
• Request and body-size limits to prevent denial-of-service and memory exhaustion
• Brute-force protection: progressive delays, account lockouts, CAPTCHA/challenge gates
• Bot, spam, and abuse prevention on public interfaces
• Account-takeover (ATO) protection: credential stuffing defense, multi-factor authentication, suspicious login detection

Input, Data & Injection Defenses:
• Input validation and strict sanitization at all system boundaries
• SQL injection defense: mandatory parameterized queries / ORM prepared statements; no string concatenation
• NoSQL injection defense: schema validation and operator sanitization
• Cross-Site Scripting (XSS) defense: context-aware output encoding, strict CSP, sanitization of rich text
• Server-Side Request Forgery (SSRF) defense: URL parsing, IP allowlisting, blocking private/internal IP ranges (metadata endpoints, RFC 1918)
• Malicious file-upload protection: file-type verification via magic bytes, file-size limits, non-executable storage, isolated cloud storage/CDN delivery, antivirus scanning

Authentication, Session & Access Control:
• Authentication architecture: strong password hashing (Argon2id, bcrypt), session token entropy
• Session security: secure cookie attributes (HttpOnly, Secure, SameSite=Strict/Lax), absolute and idle timeouts, session invalidation on logout and password reset
• Authorization & Role-Based Access Control (RBAC): server-side permission checks on every operation; client-side checks are cosmetic only
• Principle of least privilege: users, services, databases, and tools operate with the minimal permissions required

Data Protection & Cryptography:
• Encryption in transit: mandatory TLS 1.3/1.2 for all public and internal communications
• Encryption at rest: database encryption, volume encryption, sensitive column/field-level encryption
• Database security: restricted connection pools, isolated credentials, encrypted connections, access auditing
• Secrets management: zero hardcoded secrets, separation of environment configs (.env.example), secure secret vaults, automated secret scanning in CI/CD, regular key rotation

Supply Chain & Third-Party Security:
• Dependency and software supply-chain security: lockfiles, automated vulnerability scanning (Dependabot/audit), pinned dependency versions
• Webhook verification: cryptographic HMAC signature verification, timestamp checks against replay attacks
• Third-party integration security: bounded API keys, least privilege, timeout handling, circuit breakers
• Data-leak prevention (DLP): masking PII, redaction of sensitive data from logs and error responses

Operations & Incident Response:
• Audit logging: tamper-evident logging of security events (authentication, authorization failures, permission changes, administrative actions)
• Suspicious-activity detection: anomaly monitoring, automated alerting
• Backup security: encrypted backups, immutable storage, periodic restoration testing
• Incident response and recovery procedures: containment protocols, token revocation mechanisms, communication plans

───

AI-SPECIFIC SECURITY & AUTHORITY FRAMEWORK
Every project incorporating AI models, agents, tools, or automations must evaluate and enforce:

Prompt Injection Defenses:
• Direct prompt injection: robust system prompts, structural delimiter isolation, instruction/content separation
• Indirect prompt injection: treat all external data, retrieved search results, web pages, and user files as untrusted content; never allow retrieved text to override system instructions

AI Authority Boundaries & Least Privilege:
• AI agents operate under bounded autonomy; agents are assistants, not product owners or system administrators
• Tool permissions: assign only the minimum necessary tools required for the specific task
• Tool-argument validation: enforce strict schema validation on all arguments generated by AI before passing them to tool implementations
• Autonomous-action restrictions: high-impact, financial, irreversible, or destructive actions strictly require human approval gates

Data & Memory Security:
• Memory poisoning defense: validate, sanitize, and verify provenance of information before persisting into long-term memory
• Data exfiltration prevention: prohibit AI from transmitting sensitive variables, secrets, or internal system context to external endpoints
• Privacy boundaries: ensure user data from one tenant or session is isolated from others; never train or fine-tune models on confidential user data without explicit consent

Output & Behavior Containment:
• Output validation: validate all AI responses against contracts and schemas prior to presentation or downstream execution
• Hallucination containment: ground AI in verified retrieval context; require citation/provenance for factual assertions; define explicit fallback/uncertainty states
• AI abuse prevention: prompt length limits, query rate limits, abuse monitoring

Cost & Resource Governance:
• AI cost controls: enforce per-request and per-user token consumption caps
• Budget limits, quota alerts, and automatic circuit breakers
• Model selection strategy: use smaller/deterministic models where sufficient; reserve frontier models for complex reasoning

Auditability & Traceability:
• AI decision & tool-call auditability: structured logging of model provider, version, prompt token counts, completion token counts, tool execution latency, and error states
• Enforce the established Source-of-Truth Hierarchy:
  Authoritative Data → Stored Memory → Retrieved Context → AI Reasoning → Recommendation → Authorized Action

───

PRODUCT & PLATFORM COMPLETENESS SPECIFICATION
A software product is not complete merely because the backend logic or primary screens work.
During design and before production release, evaluate and deliver complete platform assets:

UI/UX & Accessibility:
• Responsive behavior: fully adaptive across mobile, tablet, desktop, and varied aspect ratios
• Accessibility (a11y): WCAG 2.1 AA compliance, keyboard navigability, screen-reader semantic landmarks, appropriate color contrast, motion-reduction support

Branding & Web Identity:
• Logos: vector SVG and raster formats, light and dark mode variants
• Favicons: favicon.ico, multi-resolution PNGs (16x16, 32x32), apple-touch-icon.png (180x180)
• Open Graph & Social Sharing: og:title, og:description, og:image (1200x630), twitter:card, twitter:image

Progressive Web Apps (PWA) & Manifests:
• Web App Manifest (manifest.json): name, short_name, icons (192x192, 512x512, maskable), start_url, display mode, background_color, theme_color
• Service worker strategy where applicable (offline caching, update prompts)

Mobile & App Store Platform Assets (when applicable):
• Android launcher icons: standard and adaptive icons (foreground, background, monochrome)
• Android notification icons: distinct monochrome alpha assets adhering to Android design guidelines
• iOS app icons: full asset catalog (all required iPhone and iPad resolutions)
• iOS notification icons and spotlight assets
• Splash screens / launch screens: native launch storyboards or launch screens supporting light/dark themes
• Notification permissions & privacy: clear rationale prior to system permission prompts; respect notification channels and quiet hours
• Deep linking & Universal links: Android App Links (assetlinks.json) and iOS Universal Links (apple-app-site-association), custom URL schemes
• App Store & Google Play compliance: privacy labels, permissions declarations, store listing assets, terms of service, privacy policy

Desktop Application Identity (when applicable):
• Windows icons (.ico), macOS icons (.icns), Linux desktop files and application icons
• Window title bar integration, dock/taskbar behavior, native menus, platform-specific keyboard shortcuts

Platform Behavior & Edge States:
• Offline states and network reconnection handling
• Permission-denied states (camera, location, notifications, microphone)
• Deep link fallback behavior when destination content is missing or deleted

───

RELIABILITY & OPERATIONAL READINESS FRAMEWORK
Production systems must be designed for resilience, observability, and straightforward operations:

Resilience & Execution Control:
• Error handling: explicit error types, structured error responses, graceful degradation
• Retries & Timeouts: retries with exponential backoff and randomized jitter for transient failures; strict timeouts on all external network and database calls
• Idempotency: idempotency keys for mutable operations (payments, mutations, webhook handling) to prevent duplicate side effects
• Queues & Background Processing: asynchronous job processing, dead-letter queues (DLQ), retry limits, worker health monitoring

Observability & Diagnostics:
• Health checks: distinct /healthz/live (liveness) and /healthz/ready (readiness) endpoints
• Monitoring & Metrics: latency percentiles (p50, p95, p99), throughput, error rates, resource utilization (CPU, memory, disk, connections)
• Distributed Tracing: request correlation across services, database queries, and external APIs
• Structured Logging: JSON format with timestamp, log level, request ID, user/tenant context, and sanitized message
• Alerting: proactive alerts on elevated error rates, high latency, queue depth, and resource exhaustion

Database Migrations & Data Evolution:
• Forward and backward compatible schema changes (expand-and-contract pattern)
• Zero-downtime migration strategy
• Rollback and recovery procedures for failed migrations

Release, Environments & Disaster Recovery:
• Environment isolation: complete logical or physical separation between development, testing, staging, and production
• Continuous Integration & Delivery (CI/CD): automated linting, type-checking, testing, security scans, and reproducible builds
• Rollback capability: fast rollback mechanisms (container tags, immutable deployments, blue/green or canary releases)
• Disaster Recovery (DR): documented recovery time objective (RTO) and recovery point objective (RPO), automated off-site backups, verified restore procedures
• Operational Readiness Checklist: verification of secrets, monitoring, alerts, backups, and documentation prior to production launch

───

DATA GOVERNANCE & PRIVACY FRAMEWORK
Data architecture must respect user privacy, compliance, and lifecycle boundaries:

Data Ownership & Modeling:
• Explicit ownership defined for every persistent entity and user data store
• Data minimization: collect and retain only data directly necessary for approved functionality

Retention, Archival & Deletion:
• Retention schedules: define lifecycles for logs, analytics, temporary files, and user records
• Deletion procedures: robust soft-deletion and hard-deletion mechanisms; cascade deletion of orphaned data
• Right to be forgotten: automated or operationalized workflows to completely delete user data upon request

Portability & Compliance:
• Data export: standardized export mechanisms (JSON/CSV) for user data portability
• Privacy controls: compliance with applicable privacy regulations (GDPR, CCPA/CPRA)
• Third-party data handling: strict inventory of external data processors; verify encryption and compliance agreements

───

DATA OWNERSHIP RULE
Every important data type must have:
• Owner
• Source of truth
• Access rules
• Mutation rules
• Lifecycle
• Retention policy where applicable
• Deletion behavior

───

ERROR HANDLING RULE
Errors must be explicit.
Never silently swallow failures.
Every meaningful failure should have:
• Detection
• Logging where appropriate
• User/system response
• Recovery behavior
• Retry behavior when appropriate
• Escalation when necessary

───

AI TOOL USAGE RULE
Every AI-accessible tool must define:
• Purpose
• Inputs
• Outputs
• Permissions
• Validation
• Failure behavior
• Rate limits
• Audit requirements
• Whether approval is required
AI should receive the minimum authority necessary to complete its task.

───

AUTONOMY LEVELS
Where useful, systems should explicitly define autonomy levels.
Example:
Level 0 — Observe
AI can read/analyze.
Level 1 — Recommend
AI can suggest actions.
Level 2 — Prepare
AI can prepare actions but requires approval.
Level 3 — Execute Approved Actions
AI can execute within explicitly authorized boundaries.
Level 4 — Bounded Autonomy
AI can execute predefined actions autonomously within strict limits.
Level 5 — High Autonomy
Only appropriate for systems specifically designed, tested, monitored, and authorized for it.
Increasing autonomy requires increasing:
• Testing
• Observability
• Security
• Revocation
• Auditability
• Failure handling

───

SOURCE OF TRUTH HIERARCHY
When information conflicts, use an explicit hierarchy.
Generally:
text
Approved Requirements
        ↓
Approved Architecture
        ↓
Approved Contracts
        ↓
Approved Detailed Design
        ↓
Implementation
        ↓
Runtime Behavior

If implementation contradicts architecture:
Architecture wins until formally changed.
If architecture contradicts requirements:
Requirements must be reviewed and architecture updated.
If AI reasoning contradicts authoritative data:
Authoritative data wins unless explicitly corrected.

───

ARCHITECTURE IMMUTABILITY RULE
Architecture is not frozen forever.
But architecture cannot change accidentally.
Changes require:
1. Identification
2. Reason
3. Impact analysis
4. Alternatives
5. Review
6. Approval
7. Documentation
8. Implementation
This creates controlled evolution instead of accidental evolution.

───

DEPENDENCY GOVERNANCE
Dependencies must be intentional.
Track major:
• Libraries
• Frameworks
• APIs
• AI providers
• Cloud services
• Databases
• Infrastructure services
Consider:
• Licensing
• Security
• Stability
• Maintenance
• Cost
• Vendor lock-in
• Migration difficulty

───

COST GOVERNANCE
Especially for AI systems, track:
• Model usage
• Token consumption
• API calls
• Tool execution
• Storage
• Hosting
• Third-party services
Where practical, define:
• Budget limits
• Rate limits
• Usage alerts
• Fallbacks
• Model-selection strategy

───

SCALABILITY RULE
Design for credible growth.
Do not optimize for:
10 million users
when the system has:
10 users.
But do not make architectural decisions that make obvious near-term growth impossible.
Balance:
Current simplicity + credible future flexibility.

───

PERFORMANCE RULE
Performance must be measured where it matters.
Do not prematurely optimize.
Do not ignore obvious bottlenecks.
Use:
• Metrics
• Profiling
• Load testing
• Query analysis
• AI latency/cost analysis
when appropriate.

───

ACCESSIBILITY RULE
User-facing applications should consider accessibility from design through implementation.
Accessibility is not a final cosmetic pass.
Consider:
• Keyboard navigation
• Screen readers
• Contrast
• Text sizing
• Focus states
• Motion
• Labels
• Error communication

───

PROJECT TEMPLATE STANDARD
A mature project should generally contain:
text
project/
│
├── docs/
│   ├── idea.md
│   ├── vision.md
│   ├── requirements.md
│   ├── user-stories.md
│   ├── governance.md
│   ├── architecture.md
│   ├── detailed-design.md
│   ├── testing-strategy.md
│   ├── threat-model.md
│   ├── decisions/
│   └── services/
│
├── src/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── security/
│
├── scripts/
│
├── public/
│
├── .github/
│   └── workflows/
│
├── README.md
├── CHANGELOG.md
├── ROADMAP.md
├── TASKS.md
├── PROJECT_STATE.md
├── CLAUDE.md
├── GEMINI.md
├── ARCHITECT.md
├── .gitignore
└── .env.example

Again:
This is a template, not a command to create every directory immediately.
Create only what the architecture requires.

───

AI AGENT PROJECT INSTRUCTIONS
Every project using AI coding agents should provide clear instructions.
Relevant agent instruction files may include:
text
CLAUDE.md
GEMINI.md
ARCHITECT.md

These should communicate:
• Project purpose
• Architecture
• Coding standards
• Repository rules
• Testing rules
• Documentation rules
• Agent role
• Forbidden behavior
• Current state
• How to update project state
Agent instructions must not contradict the authoritative architecture and requirements.

───

AGENT CONTEXT LOADING ORDER
Before implementation, an AI agent should conceptually load:
text
1. Project purpose
2. Requirements
3. User stories
4. Governance
5. Architecture
6. Technology decisions / ADRs
7. Contracts
8. Detailed design
9. Relevant service specification
10. Change impact classification
11. Current task
12. PROJECT_STATE

Then:
Verify → Classify → Plan → Implement → Test → Review → Document → Update State

───

LEARNING-FIRST ENGINEERING
The system is designed not only to produce code but to help the human owner understand the system over time.
AI-generated code must be explainable.
When appropriate, agents should explain:
• What was built
• Why it was built
• Which architectural boundary it belongs to
• What dependencies it uses
• What assumptions were made
• What tests verify it
• What could fail
• What future changes might affect it
The goal is:
AI accelerates implementation without permanently replacing human understanding.
The human should progressively become capable of:
• Reading the architecture
• Understanding the repository
• Reading code
• Debugging
• Evaluating AI-generated code
• Making technical decisions
• Reviewing agents
• Eventually implementing independently where desired

───

FINAL ENGINEERING PIPELINE
The universal process is:
text
IDEA
 ↓
PROBLEM DISCOVERY
 ↓
VISION
 ↓
SCOPE LOCK
 ↓
REQUIREMENTS
 ↓
USER STORIES
 ↓
WORKFLOWS
 ↓
GOVERNANCE
 ↓
SAFETY
 ↓
AUTHORITY
 ↓
ARCHITECTURE
 ↓
TECHNOLOGY SELECTION
 ↓
ARCHITECTURE DECISIONS
 ↓
CONTRACTS
 ↓
DETAILED DESIGN
 ↓
SERVICE SPECIFICATIONS
 ↓
INTELLIGENCE DESIGN
 ↓
AUTOMATION DESIGN
 ↓
RUNTIME DESIGN
 ↓
REPOSITORY DESIGN
 ↓
ROADMAP
 ↓
CHANGE IMPACT CLASSIFICATION
 ↓
TASKS
 ↓
VERTICAL SLICE
 ↓
IMPLEMENTATION
 ↓
TESTING
 ↓
REVIEW
 ↓
SECURITY REVIEW
 ↓
OBSERVABILITY REVIEW
 ↓
DEPLOYMENT
 ↓
PROJECT STATE
 ↓
POSTMORTEM
 ↓
CONTROLLED ITERATION


───

MASTER RULE
The objective is not to write code.
The objective is to build maintainable systems efficiently.
Code is the final implementation mechanism.
AI is an accelerator.
Architecture is the foundation.
Requirements define purpose.
Contracts define boundaries.
Tests define verified behavior.
Documentation preserves knowledge.
Governance defines authority.
Observability provides visibility.
Version control provides history.
Human review provides accountability.
Change classification determines the appropriate level of rigor.
The system must evolve deliberately.

───

FINAL STANDARD
Before declaring any project complete, ask:
Does the system solve the intended problem?
Is the current scope clearly defined?
Does the architecture match the requirements?
Are responsibilities clearly owned?
Are dependencies controlled?
Are contracts defined?
Is the data model understood?
Are security and authority boundaries defined?
Is AI authority explicitly bounded?
Is memory distinguished from truth?
Is the UI complete where a UI is required?
Are user workflows complete?
Are errors and edge cases handled?
Are tests present?
Is the system observable enough to diagnose?
Are migrations and compatibility considered?
Are technology decisions documented?
Are architecture decisions documented?
Is the repository understandable?
Is the code maintainable?
Is technical debt visible?
Is the change appropriately classified?
Is the project state current?
Can another developer or AI agent understand the system without guessing?
Can the human owner gradually understand and maintain what the AI built?
Was the engineering process proportional to the actual risk and complexity?
If the answer is no:
The system is not finished.

───

THE ULTIMATE PRINCIPLE
Do not build software randomly.
Understand the problem.
Define the vision.
Define the requirements.
Define the users and workflows.
Define authority and safety.
Design the architecture.
Choose technology deliberately.
Define the contracts.
Complete the detailed design for the current scope.
Classify the change before implementation.
Apply engineering rigor proportional to its impact.
Define the repository.
Break the work into small testable tasks.
Build vertical slices.
Let AI accelerate implementation without allowing it to silently control architecture.
Test everything that matters.
Review everything important.
Observe what runs.
Document what changed.
Track the state of the project.
Learn from failures.
Then expand deliberately.
Build systems that can survive their creators' future decisions.