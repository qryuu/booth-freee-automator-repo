const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand } = require("@aws-sdk/client-secrets-manager");
const { parse } = require('csv-parse');

// 定数
const SECRET_NAME = "booth-freee-automator/credentials";
const REGION = process.env.AWS_REGION || "ap-northeast-1";

const s3Client = new S3Client({ region: REGION });
const secretsClient = new SecretsManagerClient({ region: REGION });

/**
 * AWS Secrets Managerから機密情報を取得する関数
 */
async function getSecrets() {
    console.log("Fetching secrets from Secrets Manager...");
    const command = new GetSecretValueCommand({ SecretId: SECRET_NAME });
    try {
        const data = await secretsClient.send(command);
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
 * リフレッシュトークンを使って新しいアクセストークンを取得し、新しいリフレッシュトークンを保存する関数
 */
async function refreshAccessToken(secrets) {
    console.log("Refreshing freee access token...");
    const url = "https://accounts.secure.freee.co.jp/public_api/token";
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', secrets.FREEE_CLIENT_ID);
    params.append('client_secret', secrets.FREEE_CLIENT_SECRET);
    params.append('refresh_token', secrets.FREEE_REFRESH_TOKEN);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Failed to refresh token: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const tokenData = await response.json();
        console.log("Successfully refreshed access token.");

        // ★★★
        // 新しいリフレッシュトークンでSecrets Managerを更新する
        // ★★★
        const newSecrets = { ...secrets, FREEE_REFRESH_TOKEN: tokenData.refresh_token };
        const updateCommand = new UpdateSecretCommand({
            SecretId: SECRET_NAME,
            SecretString: JSON.stringify(newSecrets),
        });
        await secretsClient.send(updateCommand);
        console.log("Successfully updated the refresh token in Secrets Manager.");

        return tokenData.access_token;

    } catch (error) {
        console.error("Error refreshing access token:", error);
        throw error;
    }
}


/**
 * freee APIに取引を登録する関数
 */
async function postToFreee(order, accessToken, secrets) {
    const url = "https://api.freee.co.jp/api/1/deals";
    const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "X-Api-Version": "2020-06-15"
    };

    const payload = {
        "issue_date": order.date,
        "type": "income",
        "company_id": parseInt(secrets.FREEE_COMPANY_ID, 10),
        "details": [
            {
                "account_item_id": parseInt(secrets.FREEE_ITEM_ID_URIAGE, 10),
                "tax_code": parseInt(secrets.FREEE_TAX_CODE_URIAGE, 10),
                "amount": order.totalAmount,
                "description": `PixivBooth 注文番号: ${order.orderId}`
            },
            {
                "account_item_id": parseInt(secrets.FREEE_ITEM_ID_TESURYO, 10),
                "tax_code": parseInt(secrets.FREEE_TAX_CODE_SHIIRE, 10),
                "amount": -order.fee
            }
        ],
        "payments": [
            {
                "date": order.date,
                "from_walletable_type": "wallet",
                "from_walletable_id": parseInt(secrets.FREEE_WALLETABLE_ID, 10),
                "amount": order.totalAmount - order.fee
            }
        ]
    };

    console.log(`Posting order ${order.orderId} to freee...`);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`freee API Error: ${response.status} ${response.statusText} - ${errorBody}`);
        }
        
        const responseData = await response.json();
        console.log(`Successfully posted order ${order.orderId}. Deal ID: ${responseData.deal.id}`);
        return responseData;
    } catch (error) {
        console.error(`Failed to post order ${order.orderId} to freee:`, error);
        throw error;
    }
}

/**
 * S3からCSVファイルを読み込み、解析する関数
 */
async function parseCsvFromS3(bucket, key) {
     // ... (この関数は変更なし)
}


/**
 * AWS Lambda handler function.
 */
exports.handler = async (event, context) => {
    console.log("Lambda function triggered by S3 event (Final Version)");

    try {
        const secrets = await getSecrets();
        const accessToken = await refreshAccessToken(secrets);

        const bucket = event.Records[0].s3.bucket.name;
        const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));
        
        const records = await parseCsvFromS3(bucket, key);
        console.log(`Parsed ${records.length} records from CSV.`);
        
        for (const record of records) {
            const orderData = {
                orderId: record['注文番号'],
                date: new Date(record['注文日時']).toISOString().split('T')[0],
                totalAmount: parseInt(record['小計']?.replace(/,/g, '') || '0', 10),
                fee: Math.abs(parseInt(record['手数料']?.replace(/,/g, '') || '0', 10))
            };
            
            if (!orderData.orderId || !orderData.date || isNaN(orderData.totalAmount)) {
                console.warn("Skipping invalid record:", record);
                continue;
            }

            console.log("Processing order:", orderData);
            await postToFreee(orderData, accessToken, secrets); 
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ message: `Successfully processed and posted ${records.length} orders from ${key}.` }),
        };

    } catch (error) {
        console.error("An error occurred during handler execution:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Handler execution failed.', error: error.message }),
        };
    }
};

