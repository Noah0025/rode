import { test, expect } from 'bun:test'
import { loadConfig } from './config'

test('缺 token 时报错', () => { expect(() => loadConfig({})).toThrow(/token/i) })
test('读端口默认 18790', () => { expect(loadConfig({ RODE_GLASSES_TOKEN: 'x' }).port).toBe(18790) })
test('端口可覆盖', () => { expect(loadConfig({ RODE_GLASSES_TOKEN: 'x', PORT: '9000' }).port).toBe(9000) })
