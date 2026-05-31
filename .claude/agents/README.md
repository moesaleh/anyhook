# Subagent Catalog

**154 specialized subagents** installed in this project's `.claude/agents/`, sourced from
[VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents).

Claude Code auto-discovers every `*.md` file in this directory (this `README.md` is ignored).
Agents are invoked **automatically** when their `description` matches your task, or **explicitly**:

> "Use the `code-reviewer` subagent on my latest commit."

Run `/agents` to browse, edit, or adjust tool permissions interactively.

## Model legend

Each agent's `model` field routes it to a Claude tier:

| Tier | Used for | Count |
|------|----------|------:|
| `opus` | Deep reasoning — architecture, security, finance | 25 |
| `sonnet` | Everyday coding — build, debug, refactor | 103 |
| `haiku` | Quick tasks — docs, search, dependency checks | 18 |
| `inherit` | No explicit `model:` field — uses your current session model | 8 |

> The 8 `inherit` agents (no `model:` field) are reasoning/analysis agents; they run on whatever
> model your session uses. Add an explicit `model:` to any of them if you want to pin a tier.

## Categories

| # | Category | Agents |
|---|----------|-------:|
| 01 | [Core Development](#01--core-development) | 11 |
| 02 | [Language Specialists](#02--language-specialists) | 30 |
| 03 | [Infrastructure](#03--infrastructure) | 16 |
| 04 | [Quality & Security](#04--quality--security) | 17 |
| 05 | [Data & AI](#05--data--ai) | 13 |
| 06 | [Developer Experience](#06--developer-experience) | 15 |
| 07 | [Specialized Domains](#07--specialized-domains) | 14 |
| 08 | [Business & Product](#08--business--product) | 16 |
| 09 | [Meta & Orchestration](#09--meta--orchestration) | 11 |
| 10 | [Research & Analysis](#10--research--analysis) | 11 |
| | **Total** | **154** |

---

## 01 · Core Development

| Agent | Model | Purpose |
|-------|-------|---------|
| `api-designer` | sonnet | Designs REST/GraphQL APIs with OpenAPI specs, authentication patterns, versioning strategies, and developer-friendly architecture. |
| `backend-developer` | sonnet | Builds scalable, secure server-side APIs, microservices, and backend systems in Node.js, Python, and Go. |
| `design-bridge` | opus | Translates DESIGN.md brand documents into actionable Claude Code UI instructions that faithfully replicate a product's visual identity. |
| `electron-pro` | sonnet | Builds cross-platform Electron desktop apps with native OS integration, security hardening, and signed distributable installers. |
| `frontend-developer` | sonnet | Builds performant, accessible frontend applications across React, Vue, and Angular with full-stack integration. |
| `fullstack-developer` | sonnet | Delivers complete features spanning database, API, and frontend layers as a cohesive end-to-end unit. |
| `graphql-architect` | opus | Designs and evolves GraphQL schemas, Apollo Federation architectures, and optimizes query performance across distributed graphs. |
| `microservices-architect` | opus | Designs distributed microservice architectures using Kubernetes and service mesh, decomposing monoliths for scale and resilience. |
| `mobile-developer` | sonnet | Builds cross-platform React Native and Flutter mobile apps with native performance, platform-specific features, and offline-first architecture. |
| `ui-designer` | sonnet | Creates visual interfaces, design systems, and component libraries with expert attention to aesthetics, interaction patterns, and accessibility. |
| `websocket-engineer` | sonnet | Implements real-time bidirectional communication using WebSockets and Socket.IO, scaling to millions of concurrent connections. |

## 02 · Language Specialists

| Agent | Model | Purpose |
|-------|-------|---------|
| `angular-architect` | sonnet | Architects enterprise Angular 15+ applications with RxJS patterns, state management, micro-frontend design, and performance optimization. |
| `cpp-pro` | sonnet | Builds high-performance C++ systems using modern C++20/23 features, template metaprogramming, and zero-overhead abstractions. |
| `csharp-developer` | sonnet | Builds ASP.NET Core web APIs and cloud-native .NET solutions with async patterns, dependency injection, and clean architecture. |
| `django-developer` | sonnet | Builds Django 4+ web applications and REST APIs with async views, ORM optimization, and enterprise patterns. |
| `dotnet-core-expert` | sonnet | Builds cloud-native .NET Core applications with minimal APIs, microservices architecture, and cross-platform deployment. |
| `dotnet-framework-4.8-expert` | sonnet | Maintains and modernizes legacy .NET Framework 4.8 enterprise applications including Web Forms, WCF, and Windows services. |
| `elixir-expert` | sonnet | Builds fault-tolerant concurrent systems with OTP patterns, GenServer architectures, and Phoenix for real-time applications. |
| `expo-react-native-expert` | sonnet | Builds mobile apps with Expo and React Native covering native modules, navigation, animations, push notifications, and store deployment. |
| `fastapi-developer` | sonnet | Builds modern async Python APIs with FastAPI using Pydantic v2 validation, dependency injection, and ASGI deployment. |
| `flutter-expert` | sonnet | Builds cross-platform Flutter 3+ mobile apps with custom UI, state management, native integrations, and iOS/Android/Web optimization. |
| `golang-pro` | sonnet | Builds Go applications with concurrent programming, high-performance microservices, and idiomatic cloud-native patterns. |
| `java-architect` | sonnet | Designs enterprise Java architectures and Spring Boot microservices for scalable cloud-native systems using Java 17+ LTS. |
| `javascript-pro` | sonnet | Builds and optimizes modern JavaScript code for browser or Node.js using ES2023+ features, async patterns, and performance techniques. |
| `kotlin-specialist` | sonnet | Builds Kotlin applications with advanced coroutines, multiplatform code sharing, and Android/server-side functional programming. |
| `laravel-specialist` | sonnet | Builds Laravel 10+ applications with Eloquent ORM, queue systems, and optimized API performance. |
| `nextjs-developer` | sonnet | Builds production Next.js 14+ applications with App Router, server components, and Core Web Vitals optimization. |
| `node-specialist` | sonnet | Builds and debugs Node.js backend applications, APIs, CLIs, and microservices with deep ecosystem knowledge. |
| `php-pro` | sonnet | Builds PHP 8.3+ enterprise applications with strict typing, Laravel/Symfony frameworks, and async/Fiber patterns. |
| `powershell-5.1-expert` | sonnet | Automates Windows infrastructure tasks with PowerShell 5.1, RSAT modules, AD/DNS/DHCP/GPO management in legacy .NET environments. |
| `powershell-7-expert` | sonnet | Builds cross-platform cloud automation scripts and Azure orchestration pipelines with PowerShell 7+ and enterprise error handling. |
| `python-pro` | sonnet | Builds type-safe production Python code for web APIs, system utilities, and complex applications with modern async patterns. |
| `rails-expert` | sonnet | Builds and modernizes Rails 7.x/8.x applications with Hotwire, API development, background jobs, and idiomatic conventions. |
| `react-specialist` | sonnet | Optimizes React 18+ applications for performance and implements advanced state management and architectural patterns. |
| `rust-engineer` | sonnet | Builds Rust systems with memory safety, ownership patterns, zero-cost abstractions, and async high-performance services. |
| `spring-boot-engineer` | sonnet | Builds enterprise Spring Boot 3+ applications with microservices architecture, reactive programming, and cloud-native deployment. |
| `sql-pro` | sonnet | Optimizes complex SQL queries and schemas across PostgreSQL, MySQL, SQL Server, and Oracle with advanced index and warehouse patterns. |
| `swift-expert` | sonnet | Builds native iOS/macOS and server-side Swift apps with async/await concurrency, SwiftUI modernization, and protocol-oriented design. |
| `symfony-specialist` | sonnet | Builds Symfony 6+/7+/8+ applications with Doctrine ORM, Messenger async processing, and API Platform optimization. |
| `typescript-pro` | sonnet | Implements TypeScript with advanced type system patterns, complex generics, and end-to-end type safety across full-stack applications. |
| `vue-expert` | sonnet | Builds Vue 3 applications with Composition API, reactivity optimization, and Nuxt 3 for enterprise-scale performance. |

## 03 · Infrastructure

| Agent | Model | Purpose |
|-------|-------|---------|
| `azure-infra-engineer` | sonnet | Designs, deploys, and manages Azure infrastructure with network architecture, Entra ID integration, PowerShell automation, and Bicep IaC. |
| `cloud-architect` | opus | Designs and optimizes multi-cloud infrastructure across AWS, Azure, and GCP including migrations, DR, cost optimization, and compliance. |
| `database-administrator` | sonnet | Optimizes database performance, implements high-availability architectures, and manages disaster recovery for production database systems. |
| `deployment-engineer` | haiku | Designs, builds, and optimizes CI/CD pipelines and deployment automation strategies for reliable production releases. |
| `devops-engineer` | sonnet | Builds and optimizes infrastructure automation, CI/CD pipelines, containerization strategies, and deployment workflows. |
| `devops-incident-responder` | sonnet | Responds to production incidents, diagnoses critical service failures, and conducts postmortems to implement permanent fixes. |
| `docker-expert` | sonnet | Builds, optimizes, and secures Docker container images and orchestration using multi-stage builds and security hardening. |
| `incident-responder` | sonnet | Manages active security breaches, service outages, and operational incidents with evidence preservation and coordinated recovery. |
| `kubernetes-specialist` | sonnet | Designs, deploys, configures, and troubleshoots Kubernetes clusters and workloads in production with security hardening. |
| `network-engineer` | sonnet | Designs, optimizes, and troubleshoots cloud and hybrid network infrastructures addressing security, performance, and reliability. |
| `platform-engineer` | opus | Builds internal developer platforms, self-service infrastructure, and golden paths to reduce developer friction. |
| `security-engineer` | opus | Implements infrastructure security, integrates automated controls into CI/CD, and establishes compliance and vulnerability management. |
| `sre-engineer` | sonnet | Establishes system reliability through SLOs, error budgets, toil reduction, chaos engineering, and incident response optimization. |
| `terraform-engineer` | sonnet | Builds, refactors, and scales infrastructure as code using Terraform for multi-cloud with module architecture and state management. |
| `terragrunt-expert` | sonnet | Orchestrates OpenTofu/Terraform at scale using DRY Terragrunt configurations, stacks, units, and multi-environment patterns. |
| `windows-infra-admin` | sonnet | Manages Windows Server, Active Directory, DNS, DHCP, and Group Policy with safe automation and compliance validation. |

## 04 · Quality & Security

| Agent | Model | Purpose |
|-------|-------|---------|
| `accessibility-tester` | haiku | Comprehensive accessibility testing and WCAG 2.1/3.0 compliance verification for inclusive digital experiences. |
| `ad-security-reviewer` | opus | Audits Active Directory security posture, privilege escalation risks, and authentication protocol hardening. |
| `ai-writing-auditor` | opus | Detects and removes AI writing patterns from text to make AI-assisted content sound natural and human. |
| `architect-reviewer` | opus | Evaluates system design decisions, architectural patterns, and technology choices at the macro level. |
| `chaos-engineer` | sonnet | Designs controlled failure experiments and game day exercises to validate system resilience before real incidents. |
| `code-reviewer` | opus | Conducts comprehensive code reviews focusing on quality, security vulnerabilities, and best practices. |
| `compliance-auditor` | opus | Achieves regulatory compliance and prepares for audits across GDPR, HIPAA, PCI DSS, SOC 2, and ISO frameworks. |
| `debugger` | sonnet | Diagnoses and fixes bugs, identifies root causes of failures, and analyzes error logs and stack traces. |
| `error-detective` | sonnet | Diagnoses error occurrences, correlates errors across services, identifies root causes, and prevents future failures. |
| `gdpr-ccpa-compliance` | inherit | Helps teams understand GDPR and CCPA obligations, review data practices, and close privacy compliance gaps. |
| `penetration-tester` | opus | Conducts authorized security penetration tests to identify real vulnerabilities through active exploitation and validation. |
| `performance-engineer` | sonnet | Identifies and eliminates performance bottlenecks in applications, databases, and infrastructure systems. |
| `powershell-security-hardening` | opus | Hardens PowerShell automation, secures remoting, enforces least-privilege design, and aligns with enterprise security baselines. |
| `qa-expert` | sonnet | Provides comprehensive QA strategy, test planning across the development cycle, and quality metrics analysis. |
| `security-auditor` | opus | Conducts comprehensive security audits, compliance assessments, and risk evaluations with systematic vulnerability analysis. |
| `test-automator` | sonnet | Builds and enhances automated test frameworks, creates test scripts, and integrates testing into CI/CD pipelines. |
| `ui-ux-tester` | sonnet | Exhaustive UI and UX functionality testing driven by user flows, with structured defect reporting and visual proof. |

## 05 · Data & AI

| Agent | Model | Purpose |
|-------|-------|---------|
| `ai-engineer` | opus | Architects, implements, and optimizes end-to-end AI systems from model selection and training pipelines to production deployment. |
| `data-analyst` | haiku | Extracts business insights, creates dashboards and reports, and performs statistical analysis to support data-driven decisions. |
| `data-engineer` | sonnet | Designs, builds, and optimizes data pipelines, ETL/ELT processes, and data infrastructure including lakes and warehouses. |
| `data-scientist` | sonnet | Analyzes data patterns, builds predictive models, runs hypothesis tests, and translates findings into business recommendations. |
| `database-optimizer` | sonnet | Analyzes slow queries, optimizes database performance, and implements indexing strategies across multiple database systems. |
| `llm-architect` | opus | Designs production LLM systems including fine-tuning, RAG architectures, inference serving, and multi-model deployments. |
| `machine-learning-engineer` | sonnet | Deploys, optimizes, and serves machine learning models at scale in production with reliable inference infrastructure. |
| `ml-engineer` | sonnet | Builds production ML systems with training pipelines, model serving infrastructure, performance optimization, and automated retraining. |
| `mlops-engineer` | sonnet | Designs ML infrastructure, sets up CI/CD for models, and establishes versioning, experiment tracking, and operational monitoring. |
| `nlp-engineer` | sonnet | Builds production NLP systems, text processing pipelines, and fine-tuned language models for NER, sentiment, and translation. |
| `postgres-pro` | sonnet | Optimizes PostgreSQL performance, designs high-availability replication, tunes configuration, and implements backup strategies at scale. |
| `prompt-engineer` | sonnet | Designs, optimizes, tests, and evaluates prompts for LLMs in production, focusing on consistency, reliability, and token efficiency. |
| `reinforcement-learning-engineer` | sonnet | Designs RL environments, trains agents with reward optimization, implements policy gradient methods, and deploys decision systems. |

## 06 · Developer Experience

| Agent | Model | Purpose |
|-------|-------|---------|
| `build-engineer` | haiku | Optimizes build performance, reduces compilation times, and scales build systems across growing teams. |
| `cli-developer` | sonnet | Builds intuitive command-line tools and terminal applications with cross-platform compatibility and optimized DX. |
| `dependency-manager` | haiku | Audits dependencies for vulnerabilities, resolves version conflicts, and implements automated dependency updates. |
| `documentation-engineer` | haiku | Creates and overhauls comprehensive documentation systems including API docs, tutorials, and developer guides. |
| `dx-optimizer` | sonnet | Optimizes the complete developer workflow including build times, feedback loops, and developer satisfaction metrics. |
| `git-workflow-manager` | haiku | Designs and optimizes Git workflows, branching strategies, and merge management for projects and teams. |
| `legacy-modernizer` | sonnet | Modernizes legacy systems with incremental migration strategies and risk mitigation while maintaining business continuity. |
| `mcp-developer` | sonnet | Builds, debugs, and optimizes Model Context Protocol (MCP) servers and clients connecting AI to external tools. |
| `powershell-module-architect` | sonnet | Architects and refactors PowerShell modules, profile systems, and cross-version compatible automation libraries. |
| `powershell-ui-architect` | sonnet | Designs desktop GUIs (WinForms, WPF, Metro) and TUIs for PowerShell automation with clean UI/logic separation. |
| `readme-generator` | sonnet | Generates maintainer-ready READMEs from deep codebase scanning with zero hallucination and exact repository reality. |
| `refactoring-specialist` | sonnet | Transforms poorly structured, complex, or duplicated code into clean maintainable systems while preserving behavior. |
| `slack-expert` | sonnet | Develops Slack applications, implements Slack API integrations, and reviews bot code for security and best practices. |
| `tooling-engineer` | sonnet | Builds and enhances developer tools including CLIs, code generators, build tools, and IDE extensions. |
| `visual-asset-generator` | sonnet | Generates production-ready visual assets (icons, favicons, OG images, logos) via a prompt-to-asset MCP across 30+ image models. |

## 07 · Specialized Domains

| Agent | Model | Purpose |
|-------|-------|---------|
| `api-documenter` | haiku | Creates and improves API documentation including OpenAPI specs, interactive portals, and code examples. |
| `blockchain-developer` | sonnet | Builds smart contracts, DApps, and blockchain protocols with expertise in Solidity, gas optimization, and Web3 integration. |
| `embedded-systems` | sonnet | Develops firmware for resource-constrained microcontrollers, RTOS applications, and real-time systems with strict latency requirements. |
| `fintech-engineer` | opus | Builds secure payment systems and compliance-heavy financial applications with high transaction accuracy and regulatory adherence. |
| `game-developer` | sonnet | Implements game systems, graphics rendering, multiplayer networking, and gameplay mechanics for platform-specific games. |
| `healthcare-admin` | opus | Covers healthcare administration including revenue cycle management, medical coding, HIPAA compliance, and health IT interoperability. |
| `hipaa-compliance` | inherit | Guides healthcare product teams through HIPAA obligations, PHI safeguards, BAA requirements, and compliance gap analysis. |
| `iot-engineer` | sonnet | Designs IoT solutions covering device management, edge computing, cloud integration, and real-time data pipelines at massive scale. |
| `m365-admin` | sonnet | Automates Microsoft 365 admin tasks including Exchange, Teams, SharePoint, license management, and Graph API identity automation. |
| `mobile-app-developer` | sonnet | Develops iOS and Android mobile apps focused on native or cross-platform performance and platform-specific user experience. |
| `payment-integration` | opus | Implements payment systems and gateway integrations with PCI compliance, fraud prevention, and secure transaction processing. |
| `quant-analyst` | opus | Develops quantitative trading strategies, financial models, backtesting frameworks, and advanced risk analytics for derivatives. |
| `risk-manager` | opus | Identifies, quantifies, and mitigates enterprise risks across financial, operational, regulatory, and strategic domains. |
| `seo-specialist` | haiku | Provides comprehensive SEO optimization including technical audits, keyword strategy, content optimization, and ranking improvement. |

## 08 · Business & Product

| Agent | Model | Purpose |
|-------|-------|---------|
| `assumption-mapping` | inherit | Identifies and prioritizes risky assumptions in product ideas, features, or strategies to guide risk-driven validation. |
| `backlog-grooming` | inherit | Grooms and refines product backlogs to keep items well-estimated, well-defined, prioritized, and sprint-ready. |
| `business-analyst` | sonnet | Analyzes business processes, gathers stakeholder requirements, and identifies process improvements for operational efficiency. |
| `content-marketer` | haiku | Develops comprehensive content strategies and SEO-optimized multi-channel campaigns to drive engagement and conversions. |
| `content-quality-editor` | haiku | Strips AI writing patterns from generated content and applies editorial judgment to make it read like human writing. |
| `customer-success-manager` | sonnet | Assesses customer health, develops retention strategies, identifies upsell opportunities, and maximizes customer lifetime value. |
| `growth-loops` | inherit | Designs self-reinforcing product growth loops and PLG mechanics for sustainable, compounding user acquisition. |
| `legal-advisor` | sonnet | Drafts contracts, reviews compliance requirements, develops IP protection strategies, and assesses legal risks for tech businesses. |
| `license-engineer` | opus | Architects and implements end-to-end software licensing systems covering OSS selection, compliance pipelines, and risk monitoring. |
| `product-manager` | haiku | Makes product strategy decisions, prioritizes features, and defines roadmap plans based on user needs and business goals. |
| `project-manager` | haiku | Establishes project plans, tracks execution, manages risks, controls budget/schedule, and coordinates stakeholders. |
| `sales-engineer` | sonnet | Conducts technical pre-sales activities including solution architecture, proof-of-concept development, and technical demos. |
| `scrum-master` | haiku | Facilitates agile ceremonies, optimizes team processes, improves velocity, and removes impediments for scrum teams. |
| `technical-writer` | haiku | Creates and maintains technical documentation including API references, user guides, SDK docs, and getting-started guides. |
| `ux-researcher` | sonnet | Conducts user research, analyzes behavior, and generates actionable insights to validate design decisions and uncover user needs. |
| `wordpress-master` | sonnet | Architects, optimizes, and troubleshoots WordPress implementations from custom themes/plugins to enterprise multisite platforms. |

## 09 · Meta & Orchestration

| Agent | Model | Purpose |
|-------|-------|---------|
| `agent-installer` | haiku | Discovers, browses, and installs Claude Code agents from the awesome-claude-code-subagents GitHub repository. |
| `agent-organizer` | sonnet | Assembles and optimizes multi-agent teams for complex projects via task decomposition and capability matching. |
| `codebase-orchestrator` | opus | Repository-wide refactor governance with approval loops, risk prioritization, diff previews, and deterministic fallback strategies. |
| `context-manager` | sonnet | Manages shared state and data synchronization so multiple agents have coordinated, consistent access to context. |
| `error-coordinator` | sonnet | Coordinates distributed system error handling, automates failure detection, and prevents cascading failures across components. |
| `it-ops-orchestrator` | sonnet | Routes complex IT operations tasks spanning PowerShell, .NET, Azure, and M365 to the appropriate specialist agents. |
| `knowledge-synthesizer` | sonnet | Extracts actionable patterns from agent interactions and synthesizes cross-workflow insights for organizational learning. |
| `multi-agent-coordinator` | opus | Coordinates concurrent agents with shared state, inter-agent communication, and distributed failure handling. |
| `performance-monitor` | haiku | Establishes observability to track metrics, detect anomalies, and optimize resources in multi-agent environments. |
| `task-distributor` | haiku | Distributes tasks across agents or workers with queue management and load balancing to maximize throughput. |
| `workflow-orchestrator` | opus | Designs, implements, and optimizes complex business process workflows with state management, error handling, and transactions. |

## 10 · Research & Analysis

| Agent | Model | Purpose |
|-------|-------|---------|
| `ab-test-analysis` | inherit | Analyzes A/B test results, interprets p-values, determines statistical significance, and guides ship/no-ship decisions. |
| `cohort-analysis` | inherit | Analyzes user retention, cohort behavior, and engagement trends to understand how different user groups perform over time. |
| `competitive-analyst` | sonnet | Analyzes direct and indirect competitors, benchmarks against market leaders, and develops competitive positioning strategies. |
| `data-researcher` | sonnet | Discovers, collects, and validates data from multiple sources for analysis, quality checking, and preparation for modeling. |
| `first-principles-thinking` | inherit | Challenges assumptions and breaks complex problems down to fundamental truths using first principles reasoning from scratch. |
| `market-researcher` | sonnet | Analyzes markets, consumer behavior, and competitive landscapes to size opportunities and inform business strategy. |
| `project-idea-validator` | sonnet | Pressure-tests ideas with brutal honesty, competitor teardown, and market validation to deliver clear go/no-go guidance. |
| `research-analyst` | sonnet | Conducts comprehensive multi-source research, synthesizes findings into actionable insights, and produces detailed reports. |
| `scientific-literature-researcher` | sonnet | Searches scientific literature and retrieves structured experimental data including methods, results, and quality scores. |
| `search-specialist` | sonnet | Finds specific information across multiple sources using advanced search strategies and query optimization for precise retrieval. |
| `trend-analyst` | sonnet | Analyzes emerging patterns and predicts industry shifts to develop future scenarios for strategic planning. |

---

*Source: [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) · 154 agents across 10 categories · installed to project-level `.claude/agents/`.*
