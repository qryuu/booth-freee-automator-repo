const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

/**
 * AWS Lambda handler function.
 * @param {object} event - The Lambda event object.
 * @param {object} context - The Lambda context object.
 * @returns {Promise<object>} - The response object.
 */
exports.handler = async (event, context) => {
    let browser = null;
    let result = null;

    console.log("Lambda function started");

    try {
        console.log("Launching Chromium...");
        // Launch a new browser instance with options optimized for Lambda.
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        let page = await browser.newPage();

        console.log("Navigating to Google...");
        await page.goto('https://www.google.com');

        const pageTitle = await page.title();
        console.log(`Successfully navigated to Google. Page title: ${pageTitle}`);

        result = `Successfully got title: ${pageTitle}`;

    } catch (error) {
        console.error(error);
        // Return a clear error message. The full error is in the CloudWatch logs.
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'An error occurred during browser automation.', error: error.message }),
        };
    } finally {
        // Ensure the browser is closed, even if an error occurred.
        if (browser !== null) {
            await browser.close();
        }
    }

    // Return a successful response.
    return {
        statusCode: 200,
        body: JSON.stringify({ message: result }),
    };
};
