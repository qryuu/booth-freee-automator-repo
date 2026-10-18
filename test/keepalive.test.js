const test = require('node:test');
const assert = require('node:assert/strict');
const { SecretsManagerClient } = require("@aws-sdk/client-secrets-manager");

test.describe('keep-alive', { concurrency: 1 }, () => {
    test('action: keep_alive イベントでトークンを延命し 200 を返す', async (t) => {
        const originalFetch = global.fetch;
        const originalSend = SecretsManagerClient.prototype.send;
        t.after(() => {
            global.fetch = originalFetch;
            SecretsManagerClient.prototype.send = originalSend;
        });

        let secretUpdated = false;
        let newRefreshToken = null;

        SecretsManagerClient.prototype.send = async (command) => {
            if (command.constructor.name === 'UpdateSecretCommand' || command.input?.SecretString) {
                secretUpdated = true;
                const parsed = JSON.parse(command.input.SecretString);
                newRefreshToken = parsed.FREEE_REFRESH_TOKEN;
                return {};
            }
            if (command.constructor.name === 'GetSecretValueCommand' || command.input?.SecretId) {
                return {
                    SecretString: JSON.stringify({
                        FREEE_CLIENT_ID: 'dummy_client_id',
                        FREEE_CLIENT_SECRET: 'dummy_client_secret',
                        FREEE_REFRESH_TOKEN: 'old_refresh_token',
                        FREEE_COMPANY_ID: '1234567'
                    })
                };
            }
            return {};
        };

        let fetchCalled = false;
        global.fetch = async (url) => {
            if (url.includes('accounts.secure.freee.co.jp/public_api/token')) {
                fetchCalled = true;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        access_token: 'new_access_token_123',
                        refresh_token: 'new_refresh_token_456',
                        expires_in: 86400,
                    }),
                    text: async () => ''
                };
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
        };

        const { handler } = require('../index.js');
        const event = { action: 'keep_alive', tenantId: 'test-creator' };
        const response = await handler(event);

        assert.equal(response.statusCode, 200);
        const body = JSON.parse(response.body);
        assert.equal(body.success, true);
        assert.ok(fetchCalled, 'freee API token endpoint が呼び出されたこと');
        assert.ok(secretUpdated, 'Secrets Manager が更新されたこと');
        assert.equal(newRefreshToken, 'new_refresh_token_456', '新しいリフレッシュトークンが保存されたこと');
    });

    test('aws.events Scheduled Event を受け取った場合も延命を実行する', async (t) => {
        const originalFetch = global.fetch;
        const originalSend = SecretsManagerClient.prototype.send;
        t.after(() => {
            global.fetch = originalFetch;
            SecretsManagerClient.prototype.send = originalSend;
        });

        SecretsManagerClient.prototype.send = async (command) => {
            if (command.input?.SecretString) return {};
            return {
                SecretString: JSON.stringify({
                    FREEE_CLIENT_ID: 'dummy_client_id',
                    FREEE_CLIENT_SECRET: 'dummy_client_secret',
                    FREEE_REFRESH_TOKEN: 'old_refresh_token'
                })
            };
        };

        global.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                access_token: 'new_access_token_789',
                refresh_token: 'new_refresh_token_999',
                expires_in: 86400,
            }),
            text: async () => ''
        });

        const { handler } = require('../index.js');
        const event = {
            source: 'aws.events',
            'detail-type': 'Scheduled Event',
            resources: ['arn:aws:events:ap-northeast-1:123456789012:rule/booth-freee-keepalive-test']
        };
        const response = await handler(event);

        assert.equal(response.statusCode, 200);
        const body = JSON.parse(response.body);
        assert.equal(body.success, true);
    });

    test('freee API 失敗時は 500 を返し [CRITICAL_ALARM] をログ記録する', async (t) => {
        const originalFetch = global.fetch;
        const originalSend = SecretsManagerClient.prototype.send;
        const originalConsoleError = console.error;
        let loggedAlarm = false;
        console.error = (...args) => {
            const str = args.join(' ');
            if (str.includes('[CRITICAL_ALARM][KEEP_ALIVE_FAILED]')) {
                loggedAlarm = true;
            }
            originalConsoleError(...args);
        };
        t.after(() => {
            global.fetch = originalFetch;
            SecretsManagerClient.prototype.send = originalSend;
            console.error = originalConsoleError;
        });

        SecretsManagerClient.prototype.send = async () => ({
            SecretString: JSON.stringify({
                FREEE_CLIENT_ID: 'dummy_client_id',
                FREEE_CLIENT_SECRET: 'dummy_client_secret',
                FREEE_REFRESH_TOKEN: 'invalid_token'
            })
        });

        global.fetch = async () => ({
            ok: false,
            status: 400,
            text: async () => '{"error":"invalid_grant","error_description":"Refresh token has expired."}'
        });

        const { handler } = require('../index.js');
        const event = { action: 'keep_alive' };
        const response = await handler(event);

        assert.equal(response.statusCode, 500);
        const body = JSON.parse(response.body);
        assert.equal(body.success, false);
        assert.ok(body.message.includes('Failed to refresh token'));
        assert.ok(loggedAlarm, 'CloudWatch アラーム用の [CRITICAL_ALARM] プレフィックスが出力されたこと');
    });
});
