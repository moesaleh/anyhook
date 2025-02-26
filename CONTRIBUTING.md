# Contributing to AnyHook

First off, thank you for considering contributing to AnyHook! It's people like you that make AnyHook such a great tool.

## Code of Conduct

This project and everyone participating in it is governed by the [AnyHook Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the issue list as you might find out that you don't need to create one. When you are creating a bug report, please include as many details as possible:

* Use a clear and descriptive title
* Describe the exact steps which reproduce the problem
* Provide specific examples to demonstrate the steps
* Describe the behavior you observed after following the steps
* Explain which behavior you expected to see instead and why
* Include logs, screenshots and code samples where possible

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, please include:

* A clear and descriptive title
* A detailed description of the proposed functionality
* Explain why this enhancement would be useful
* List some other tools or applications where this enhancement exists, if applicable

### Pull Requests

* Fill in the required template
* Do not include issue numbers in the PR title
* Include screenshots and animated GIFs in your pull request whenever possible
* Follow the JavaScript/TypeScript styleguides
* Include thoughtfully-worded, well-structured tests
* Document new code
* End all files with a newline

## Development Process

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Setup Development Environment

```bash
# Clone your fork
git clone https://github.com/your-username/anyhook.git

# Install dependencies
npm install

# Setup environment variables
cp .env.example .env

# Run development server
npm run dev
```

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- path/to/test-file.test.ts

# Run tests in watch mode
npm test -- --watch
```

### Code Style

We use ESLint and Prettier to maintain code quality. Before submitting a pull request, make sure your code follows our style guide:

```bash
# Check code style
npm run lint

# Fix code style issues
npm run format
```

## Project Structure

```
anyhook/
├── src/
│   ├── subscription-management/   # Subscription management service
│   ├── subscription-connector/    # Connection handling service
│   ├── webhook-dispatcher/        # Webhook dispatch service
│   └── test/                     # Test files
├── config/                       # Configuration files
├── docs/                         # Documentation
└── migrations/                   # Database migrations
```

## Documentation

* Comment your code
* Update the README.md if needed
* Add JSDoc comments for all public APIs

## Questions?

Feel free to contact the project maintainers if you have any questions or need help with your contribution.

Thank you for contributing to AnyHook! 🚀 