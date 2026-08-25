const MAXIMUM_JSON_INPUT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_JSON_NODES = 500_000;
const MAXIMUM_JSON_DEPTH = 512;

// 背景：JSON.parse 对同层重复键采用 last-wins，导致人看到的前值与 schema/hash 使用的后值
// 分裂；Review import 与 stage completion 还曾各自直接 parse。目的：在任何 schema/canonical
// work 前以同一递归下降 grammar 拒绝 root/nested duplicate、BOM、尾随值与无效 UTF-8。
// 上下文：本 decoder 只认证 JSON 文法和 key 唯一性，不做 schema default、兼容迁移或字段改写。
export function decodeStrictJson(raw: string | Uint8Array): unknown {
  const text = decodeInput(raw);
  const parser = new StrictJsonParser(text);
  parser.validateDocument();
  return JSON.parse(text) as unknown;
}

function decodeInput(raw: string | Uint8Array): string {
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAXIMUM_JSON_INPUT_BYTES) {
      throw new TypeError('strict JSON input byte budget exceeded');
    }
    return raw;
  }
  if (raw.byteLength > MAXIMUM_JSON_INPUT_BYTES) {
    throw new TypeError('strict JSON input byte budget exceeded');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new TypeError('strict JSON input is not valid UTF-8');
  }
}

class StrictJsonParser {
  private index = 0;
  private nodes = 0;

  constructor(private readonly text: string) {}

  validateDocument(): void {
    this.skipWhitespace();
    if (this.index >= this.text.length) this.fail('document is empty');
    this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail('trailing content is forbidden');
  }

  private parseValue(depth: number): void {
    if (depth > MAXIMUM_JSON_DEPTH) this.fail('depth exceeds limit');
    this.nodes += 1;
    if (this.nodes > MAXIMUM_JSON_NODES) this.fail('node budget exceeded');
    const character = this.text[this.index];
    if (character === '{') return this.parseObject(depth);
    if (character === '[') return this.parseArray(depth);
    if (character === '"') {
      this.parseString();
      return;
    }
    if (character === '-' || isDigit(character)) {
      this.parseNumber();
      return;
    }
    if (this.consumeKeyword('true') || this.consumeKeyword('false') || this.consumeKeyword('null')) return;
    this.fail('unexpected token');
  }

  private parseObject(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.consume('}')) return;
    while (true) {
      if (this.text[this.index] !== '"') this.fail('object key must be a JSON string');
      const key = this.parseString();
      if (keys.has(key)) this.fail('duplicate object key');
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(':')) this.fail("object key must be followed by ':'");
      this.skipWhitespace();
      this.parseValue(depth + 1);
      this.skipWhitespace();
      if (this.consume('}')) return;
      if (!this.consume(',')) this.fail("object entries must be separated by ','");
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume(']')) return;
    while (true) {
      this.parseValue(depth + 1);
      this.skipWhitespace();
      if (this.consume(']')) return;
      if (!this.consume(',')) this.fail("array entries must be separated by ','");
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        const decoded = JSON.parse(this.text.slice(start, this.index)) as string;
        if (!hasOnlyUnicodeScalars(decoded)) this.fail('string contains a lone Unicode surrogate');
        return decoded;
      }
      if (code <= 0x1f) this.fail('unescaped control scalar in string');
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.text[this.index];
        if (escape === 'u') {
          const digits = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) this.fail('invalid Unicode escape');
          this.index += 5;
          continue;
        }
        if (escape === '"' || escape === '\\' || escape === '/' || escape === 'b'
          || escape === 'f' || escape === 'n' || escape === 'r' || escape === 't') {
          this.index += 1;
          continue;
        }
        this.fail('invalid string escape');
      }
      this.index += 1;
    }
    this.fail('unterminated string');
  }

  private parseNumber(): void {
    if (this.consume('-') && !isDigit(this.text[this.index])) this.fail('invalid number');
    if (this.consume('0')) {
      if (isDigit(this.text[this.index])) this.fail('leading zero in number');
    } else {
      if (!isOneToNine(this.text[this.index])) this.fail('invalid number');
      while (isDigit(this.text[this.index])) this.index += 1;
    }
    if (this.consume('.')) {
      if (!isDigit(this.text[this.index])) this.fail('fraction requires a digit');
      while (isDigit(this.text[this.index])) this.index += 1;
    }
    if (this.text[this.index] === 'e' || this.text[this.index] === 'E') {
      this.index += 1;
      if (this.text[this.index] === '+' || this.text[this.index] === '-') this.index += 1;
      if (!isDigit(this.text[this.index])) this.fail('exponent requires a digit');
      while (isDigit(this.text[this.index])) this.index += 1;
    }
  }

  private consumeKeyword(keyword: string): boolean {
    if (!this.text.startsWith(keyword, this.index)) return false;
    this.index += keyword.length;
    return true;
  }

  private consume(character: string): boolean {
    if (this.text[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  private skipWhitespace(): void {
    while (this.text[this.index] === ' ' || this.text[this.index] === '\t'
      || this.text[this.index] === '\n' || this.text[this.index] === '\r') this.index += 1;
  }

  private fail(message: string): never {
    throw new TypeError(`strict JSON ${message} at code-unit offset ${this.index}`);
  }
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9';
}

function isOneToNine(value: string | undefined): boolean {
  return value !== undefined && value >= '1' && value <= '9';
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
