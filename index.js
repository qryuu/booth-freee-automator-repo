const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
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
 * S3からCSVファイルを読み込み、解析する関数
 */
async function parseCsvFromS3(bucket, key) {
    console.log(`Reading CSV from s3://${bucket}/${key}`);
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const { Body } = await s3Client.send(command);

    return new Promise((resolve, reject) => {
        const records = [];
        const parser = parse({
            columns: true, // 1行目をヘッダーとして扱う
            skip_empty_lines: true,
            trim: true,
            bom: true, // UTF-8 BOM付きCSVに対応
        });

        parser.on('readable', function(){
            let record;
            while ((record = parser.read()) !== null) {
                records.push(record);
            }
        });
        parser.on('error', (err) => reject(err));
        parser.on('end', () => {
            console.log("CSV parsing finished.");
            resolve(records);
        });

        Body.pipe(parser);
    });
}


/**
 * AWS Lambda handler function.
 */
exports.handler = async (event, context) => {
    console.log("Lambda function triggered by S3 event (Verification Step)");

    try {
        // S3イベントからバケット名とファイル名を取得
        const bucket = event.Records[0].s3.bucket.name;
        const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));
        
        // CSVを解析
        const records = await parseCsvFromS3(bucket, key);
        console.log(`Parsed ${records.length} records from CSV.`);
        
        const processedOrders = [];

        // 各レコードを処理
        for (const record of records) {
            // ★★★
            // ご提供いただいたCSVの列名に合わせて修正しました。
            // ★★★
            const orderData = {
                orderId: record['注文番号'],
                date: new Date(record['注文日時']).toISOString().split('T')[0],
                totalAmount: parseInt(record['小計']?.replace(/,/g, '') || '0', 10),
                // 手数料はCSVでマイナス値で記録されているため、絶対値に変換します。
                fee: Math.abs(parseInt(record['手数料']?.replace(/,/g, '') || '0', 10))
            };
            
            // データが空の行など、不正なデータをスキップ
            if (!orderData.orderId || !orderData.date || isNaN(orderData.totalAmount)) {
                console.warn("Skipping invalid record:", record);
                continue;
            }

            console.log("Processing order:", orderData);
            processedOrders.push(orderData);
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                message: `Successfully parsed ${processedOrders.length} orders from ${key}. Please verify the data in the logs.`,
                parsedData: processedOrders
            }),
        };

    } catch (error) {
        console.error("An error occurred during handler execution:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Handler execution failed.', error: error.message }),
        };
    }
};

