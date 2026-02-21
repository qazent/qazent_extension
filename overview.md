# PR Assistant - AI-Powered Test Case Generation

Transform your pull request workflow with AI-powered test case generation that ensures comprehensive testing coverage. PR Assistant analyzes your code changes and automatically generates structured, thorough test cases, helping development and QA teams maintain high quality standards.

## Key Features

- **AI-Powered Test Case Generation** - Leverages Google Gemini to analyze code changes and generate comprehensive test cases automatically
- **Seamless Azure DevOps Integration** - Adds a dedicated PR Assistant tab directly within your pull request interface
- **One-Click Work Item Creation** - Convert generated test cases into Azure DevOps Test Case work items instantly
- **Structured Test Documentation** - Produces complete test cases with preconditions, test steps, and expected results
- **Enhanced Test Coverage** - Ensures thorough testing by identifying edge cases and scenarios you might miss

## How It Works

1. **Open a Pull Request** - Navigate to any pull request in Azure Repos
2. **Access PR Assistant** - Click the "PR Assistant" tab to view your code changes
3. **Generate Test Cases** - Click "Generate Test Cases" to analyze changes with AI
4. **Create Work Items** - Review generated test cases and create Test Case work items with one click

![PR Assistant Tab](pr-assistant-tab.png)

![Generated Test Cases](generated-test-case.png)

![Work Item Created](work-item-created.png)

## Prerequisites

Before installing PR Assistant, ensure you have:

- **Azure DevOps Organization** - Active Azure DevOps account with appropriate permissions
- **Backend Server** - Deployed backend server to handle webhook events and AI processing (see [setup guide](https://github.com/your-repo/pr-assistant) for configuration details)
- **Google Gemini API Access** - Valid API key for Google Gemini AI service

## Quick Start

1. Install the PR Assistant extension from the Azure DevOps Marketplace
2. Configure the backend server URL in your organization settings
3. Add your Google Gemini API key to the backend configuration
4. Open any pull request and click the PR Assistant tab to start generating test cases

For detailed setup instructions, visit the [full documentation](EXTENSION_README.md).

## Benefits

- **Improve Quality** - Generate comprehensive test cases that catch issues before they reach production
- **Save Time** - Automate the tedious process of writing test case documentation
- **Maintain Consistency** - Ensure all PRs follow the same structured testing approach
- **Enable Traceability** - Link test cases directly to code changes for better audit trails

## Support

Need help or found an issue?

- **Documentation** - See [EXTENSION_README.md](EXTENSION_README.md) for detailed usage instructions
- **Issues** - Report bugs or request features on our GitHub repository
- **Questions** - Contact our support team for assistance

---

**Publisher**: QAZent
**Version**: 1.2.4
**Category**: Azure Repos
