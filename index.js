const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

// 定数
const SECRET_NAME = "booth-freee-automator/credentials";
const REGION = "ap-northeast-1";

/**
 * AWS Secrets Managerから機密情報を取得する関数
 */
async function getSecrets() {
    console.log("Fetching secrets from Secrets Manager...");
    const client = new SecretsManagerClient({ region: REGION });
    const command = new GetSecretValueCommand({ SecretId: SECRET_NAME });
    try {
        const data = await client.send(command);
        if ('SecretString' in data) {
            console.log("Successfully fetched secrets.");
            return JSON.parse(data.SecretString);
        }
    } catch (error) {
        console.error("Failed to fetch secrets:", error);
        throw error;
    }
}

/**
 * AWS Lambda handler function.
 */
exports.handler = async (event, context) => {
    console.log("Lambda function started (Scraping & Verification Step)");
    
    const secrets = await getSecrets();
    let browser = null;
    const scrapedOrders = []; // スクレイピング結果を格納する配列

    try {
        console.log("Launching Chromium...");
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();

        // 1. Pixivにログイン
        console.log("Logging into Pixiv...");
        await page.goto('https://accounts.pixiv.net/login', { waitUntil: 'networkidle2' });
        await page.type('input[type="text"]', secrets.PIXIV_EMAIL);
        await page.type('input[type="password"]', secrets.PIXIV_PASSWORD);
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        console.log("Login successful.");

        // 2. Boothの発送済み注文一覧ページに移動
        console.log("Navigating to Booth order history...");
        await page.goto('https://booth.pm/orders/sent', { waitUntil: 'networkidle2' });
        
        // 3. 各注文の詳細ページURLを取得
        const orderUrls = await page.$$eval('a.nav-item[href^="/orders/"]', links => links.map(a => a.href));
        console.log(`Found ${orderUrls.length} orders to process.`);

        if (orderUrls.length === 0) {
            return { statusCode: 200, body: JSON.stringify({ message: "No new orders found." }) };
        }

        // 4. 各注文を処理
        for (const url of orderUrls) {
            console.log(`Processing order: ${url}`);
            await page.goto(url, { waitUntil: 'networkidle2' });

            // 注文情報をスクレイピング
            // 注意：これらのセレクタはBOOTHのサイト構造が変更されると動かなくなる可能性があります。
            const orderDetails = await page.evaluate(() => {
                const orderId = document.querySelector('.order-id')?.innerText.replace('注文ID：', '').trim();
                const dateText = document.querySelector('.ordered-on')?.innerText.trim(); // "YYYY/MM/DD"
                const totalText = document.querySelector('.u-text-right.u-font-size-200')?.innerText.replace(/[¥,]/g, '').trim();
                const feeText = document.querySelector('dl.omnis-dl-list:last-child dd')?.innerText.replace(/[¥,-]/g, '').trim();

                // 日付をYYYY-MM-DD形式に変換
                const date = dateText ? new Date(dateText).toISOString().split('T')[0] : null;

                return {
                    orderId,
                    date,
                    totalAmount: totalText ? parseInt(totalText, 10) : 0,
                    fee: feeText ? parseInt(feeText, 10) : 0,
                };
            });
            
            if (!orderDetails.orderId || !orderDetails.date) {
                 console.warn("Could not scrape full order details, skipping.", url);
                 continue;
            }
            
            console.log("Scraped order details:", orderDetails);
            scrapedOrders.push(orderDetails);
        }
        
        console.log("Scraping completed.");
        return {
            statusCode: 200,
            // 確認しやすいように、スクレイピング結果の配列をbodyで返す
            body: JSON.stringify(scrapedOrders),
        };

    } catch (error) {
        console.error("An error occurred during the process:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'An error occurred during handler execution.', error: error.message }),
        };
    } finally {
        if (browser !== null) {
            await browser.close();
            console.log("Browser closed.");
        }
    }
};

