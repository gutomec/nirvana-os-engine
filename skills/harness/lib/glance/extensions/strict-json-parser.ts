export interface StrictJsonOptions {
  maxDepth: number;
  rejectTrailing: boolean;
  rejectLoneSurrogates: boolean;
  rejectNonFinite: boolean;
  rejectLeadingZero: boolean;
}

class StrictJsonParser {
  private offset = 0;

  constructor(
    private readonly text: string,
    private readonly options: StrictJsonOptions,
  ) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.options.rejectTrailing && this.offset !== this.text.length) {
      throw new SyntaxError("TRAILING");
    }
    return value;
  }

  private parseValue(depth: number): unknown {
    const current = this.text[this.offset];
    if (current === "{") return this.parseObject(depth + 1);
    if (current === "[") return this.parseArray(depth + 1);
    if (current === '"') return this.parseString();
    if (current === "t") return this.parseLiteral("true", true);
    if (current === "f") return this.parseLiteral("false", false);
    if (current === "n") return this.parseLiteral("null", null);
    if (current === "N" || current === "I" || this.text.startsWith("-Infinity", this.offset)) {
      if (this.options.rejectNonFinite) throw new SyntaxError("NONFINITE");
    }
    if (current === "-" || (current >= "0" && current <= "9")) return this.parseNumber();
    throw new SyntaxError("JSON_TOKEN");
  }

  private checkDepth(depth: number): void {
    if (depth > this.options.maxDepth) throw new SyntaxError("DEPTH");
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.checkDepth(depth);
    this.offset++;
    const result: Record<string, unknown> = Object.create(null);
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.offset] === "}") {
      this.offset++;
      return result;
    }
    while (this.offset < this.text.length) {
      if (this.text[this.offset] !== '"') throw new SyntaxError("OBJECT_KEY");
      const key = this.parseString();
      if (keys.has(key)) throw new SyntaxError("DUPLICATE_KEY");
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.offset] !== ":") throw new SyntaxError("OBJECT_COLON");
      this.offset++;
      this.skipWhitespace();
      result[key] = this.parseValue(depth);
      this.skipWhitespace();
      const separator = this.text[this.offset++];
      if (separator === "}") return result;
      if (separator !== ",") throw new SyntaxError("OBJECT_SEPARATOR");
      this.skipWhitespace();
    }
    throw new SyntaxError("OBJECT_UNTERMINATED");
  }

  private parseArray(depth: number): unknown[] {
    this.checkDepth(depth);
    this.offset++;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.offset] === "]") {
      this.offset++;
      return result;
    }
    while (this.offset < this.text.length) {
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      const separator = this.text[this.offset++];
      if (separator === "]") return result;
      if (separator !== ",") throw new SyntaxError("ARRAY_SEPARATOR");
      this.skipWhitespace();
    }
    throw new SyntaxError("ARRAY_UNTERMINATED");
  }

  private parseString(): string {
    const start = this.offset;
    this.offset++;
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset);
      if (code === 0x22) {
        this.offset++;
        const value = JSON.parse(this.text.slice(start, this.offset)) as string;
        if (this.options.rejectLoneSurrogates) this.assertNoLoneSurrogates(value);
        return value;
      }
      if (code < 0x20) throw new SyntaxError("STRING_CONTROL");
      if (code === 0x5c) {
        this.offset++;
        const escape = this.text[this.offset];
        if (escape === "u") {
          const hex = this.text.slice(this.offset + 1, this.offset + 5);
          if (!/^[a-fA-F0-9]{4}$/.test(hex)) throw new SyntaxError("STRING_ESCAPE");
          this.offset += 5;
          continue;
        }
        if (!['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escape ?? "")) {
          throw new SyntaxError("STRING_ESCAPE");
        }
      }
      this.offset++;
    }
    throw new SyntaxError("STRING_UNTERMINATED");
  }

  private assertNoLoneSurrogates(value: string): void {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) throw new SyntaxError("LONE_SURROGATE");
        index++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new SyntaxError("LONE_SURROGATE");
      }
    }
  }

  private parseNumber(): number {
    const remaining = this.text.slice(this.offset);
    if (this.options.rejectNonFinite && /^(?:-?Infinity|NaN)/.test(remaining)) {
      throw new SyntaxError("NONFINITE");
    }
    if (this.options.rejectLeadingZero && /^-?0[0-9]/.test(remaining)) {
      throw new SyntaxError("LEADING_ZERO");
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remaining);
    if (!match) throw new SyntaxError("NUMBER");
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (this.options.rejectNonFinite && !Number.isFinite(value)) throw new SyntaxError("NONFINITE");
    return value;
  }

  private parseLiteral<T>(literal: string, value: T): T {
    if (!this.text.startsWith(literal, this.offset)) throw new SyntaxError("JSON_TOKEN");
    this.offset += literal.length;
    return value;
  }

  private skipWhitespace(): void {
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a) break;
      this.offset++;
    }
  }
}

export function parseJsonWithDuplicateKeyRejection(
  text: string,
  options: StrictJsonOptions,
): unknown {
  return new StrictJsonParser(text, options).parse();
}
