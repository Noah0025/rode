import { test, expect } from 'bun:test'
import { glassesEvent } from './protocol'

test('glassesEvent 序列化为 SSE data 行', () => {
  expect(glassesEvent({ type: 'user', text: '你好' }))
    .toBe('data: {"type":"user","text":"你好"}\n\n')
})
test('done 事件无 text', () => {
  expect(glassesEvent({ type: 'done' })).toBe('data: {"type":"done"}\n\n')
})
test('answer_delta 事件携带增量文本', () => {
  expect(glassesEvent({ type: 'answer_delta', text: '晴，' }))
    .toBe('data: {"type":"answer_delta","text":"晴，"}\n\n')
})
