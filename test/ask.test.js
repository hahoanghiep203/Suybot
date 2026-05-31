import test from 'node:test';
import assert from 'node:assert';
import { feature } from '../src/features/ask.js';

test('ask command logic', async (t) => {
    await t.test('should return "duy anh" when question is "who is epstin"', async () => {
        const interaction = {
            options: {
                getString: (name) => name === 'question' ? 'who is epstin' : null
            },
            reply: async (text) => {
                assert.strictEqual(text, 'duy anh');
            }
        };
        await feature.execute(interaction);
    });

    await t.test('should return "ur mom" for other questions', async () => {
        const interaction = {
            options: {
                getString: (name) => name === 'question' ? 'hello' : null
            },
            reply: async (text) => {
                assert.strictEqual(text, 'ur mom');
            }
        };
        await feature.execute(interaction);
    });

    await t.test('should be case insensitive for "who is epstin"', async () => {
        const interaction = {
            options: {
                getString: (name) => name === 'question' ? 'WHO IS EPSTIN' : null
            },
            reply: async (text) => {
                assert.strictEqual(text, 'duy anh');
            }
        };
        await feature.execute(interaction);
    });
});
