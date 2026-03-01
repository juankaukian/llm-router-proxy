const UNIT_CONVERSION_TABLE: Record<string, number> = {
  km_to_mi: 0.62137119224,
  mi_to_km: 1.609344,
  kg_to_lb: 2.2046226218,
  lb_to_kg: 0.45359237
};

const OP: Record<string, { precedence: number; assoc: 'left' | 'right' }> = {
  '+': { precedence: 1, assoc: 'left' },
  '-': { precedence: 1, assoc: 'left' },
  '*': { precedence: 2, assoc: 'left' },
  '/': { precedence: 2, assoc: 'left' },
  '^': { precedence: 3, assoc: 'right' }
};

function trimNumber(value: number): string {
  return value.toFixed(10).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function normalizeMath(input: string): string {
  let result = input.toLowerCase().trim();
  result = result.replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/g, '($1/100*$2)');
  result = result.replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)');
  result = result.replace(/^(what is|calculate|compute|solve)\s+/i, '');
  result = result.replace(/=/g, ' ');
  result = result.replace(/,/g, '');
  result = result.replace(/\?+$/, '');
  return result.trim();
}

function tokenize(expr: string): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < expr.length) {
    const char = expr[i];
    if (!char) {
      break;
    }

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char in OP || char === '(' || char === ')') {
      const prev = out[out.length - 1];
      const unaryMinus = char === '-' && (out.length === 0 || prev === '(' || Boolean(prev && prev in OP));
      if (unaryMinus) {
        out.push('0');
      }
      out.push(char);
      i += 1;
      continue;
    }

    if (/\d|\./.test(char)) {
      let num = char;
      i += 1;
      while (i < expr.length && /\d|\./.test(expr[i] ?? '')) {
        num += expr[i];
        i += 1;
      }
      if (!/^\d*\.?\d+$/.test(num)) {
        throw new Error(`Invalid number: ${num}`);
      }
      out.push(num);
      continue;
    }

    throw new Error(`Invalid token: ${char}`);
  }

  return out;
}

function toRpn(tokens: string[]): string[] {
  const output: string[] = [];
  const ops: string[] = [];

  for (const token of tokens) {
    if (/^\d*\.?\d+$/.test(token)) {
      output.push(token);
      continue;
    }

    if (token in OP) {
      while (ops.length > 0) {
        const top = ops[ops.length - 1];
        if (!top || !(top in OP)) {
          break;
        }
        const left = OP[token]!;
        const right = OP[top]!;
        const pop =
          (left.assoc === 'left' && left.precedence <= right.precedence) ||
          (left.assoc === 'right' && left.precedence < right.precedence);
        if (!pop) {
          break;
        }
        output.push(ops.pop()!);
      }
      ops.push(token);
      continue;
    }

    if (token === '(') {
      ops.push(token);
      continue;
    }

    if (token === ')') {
      while (ops.length > 0 && ops[ops.length - 1] !== '(') {
        output.push(ops.pop()!);
      }
      if (ops.length === 0 || ops[ops.length - 1] !== '(') {
        throw new Error('Mismatched parentheses');
      }
      ops.pop();
    }
  }

  while (ops.length > 0) {
    const token = ops.pop()!;
    if (token === '(' || token === ')') {
      throw new Error('Mismatched parentheses');
    }
    output.push(token);
  }

  return output;
}

function evaluateRpn(rpn: string[]): number {
  const stack: number[] = [];

  for (const token of rpn) {
    if (/^\d*\.?\d+$/.test(token)) {
      stack.push(Number(token));
      continue;
    }

    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) {
      throw new Error('Malformed expression');
    }

    switch (token) {
      case '+':
        stack.push(a + b);
        break;
      case '-':
        stack.push(a - b);
        break;
      case '*':
        stack.push(a * b);
        break;
      case '/':
        if (b === 0) {
          throw new Error('Division by zero');
        }
        stack.push(a / b);
        break;
      case '^':
        stack.push(a ** b);
        break;
      default:
        throw new Error(`Unsupported operator: ${token}`);
    }
  }

  if (stack.length !== 1) {
    throw new Error('Malformed expression');
  }

  return stack[0]!;
}

function tryUnitConversion(input: string): string | null {
  const s = input.toLowerCase().trim();

  const tempMatch = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*(c|f)\s*(?:to|in)\s*°?\s*(c|f)/);
  if (tempMatch) {
    const value = Number(tempMatch[1]);
    const from = tempMatch[2];
    const to = tempMatch[3];
    if (from === to) {
      return `${trimNumber(value)} ${to}`;
    }
    if (from === 'c' && to === 'f') {
      return `${trimNumber(value * (9 / 5) + 32)} f`;
    }
    if (from === 'f' && to === 'c') {
      return `${trimNumber((value - 32) * (5 / 9))} c`;
    }
  }

  const match = s.match(/(-?\d+(?:\.\d+)?)\s*(km|mi|kg|lb)\s*(?:to|in)\s*(km|mi|kg|lb)/);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  const from = match[2];
  const to = match[3];
  if (from === to) {
    return `${trimNumber(value)} ${to}`;
  }

  const key = `${from}_to_${to}`;
  const factor = UNIT_CONVERSION_TABLE[key];
  if (!factor) {
    throw new Error('Unsupported conversion pair');
  }
  return `${trimNumber(value * factor)} ${to}`;
}

export function looksLikeMathOrConversion(input: string): boolean {
  const s = input.toLowerCase();
  if (/(-?\d+(?:\.\d+)?)\s*(km|mi|kg|lb|c|f)\s*(to|in)\s*(km|mi|kg|lb|c|f)/.test(s)) {
    return true;
  }
  if (/(\d|\+|-|\*|\/|\^|\(|\)|%)/.test(s) && !/[a-z]{5,}/.test(s.replace(/what|is|of|to|in|calculate|compute|solve|\s|\?|=/g, ''))) {
    return true;
  }
  return /(calculate|compute|solve|what is|convert)/.test(s) && /\d/.test(s);
}

export function evaluateMath(input: string): string {
  const conversion = tryUnitConversion(input);
  if (conversion) {
    return conversion;
  }

  const normalized = normalizeMath(input);
  if (!normalized) {
    throw new Error('No expression');
  }

  const tokens = tokenize(normalized);
  const rpn = toRpn(tokens);
  return trimNumber(evaluateRpn(rpn));
}
