
import * as Exprs from './expr.ts';
import {Token} from './token.ts'
import {Tokenizer, Options} from './tokenizer.ts'
import * as Tokens from './token.ts';
// TODO: import raw text files seems painful right now.
import * as Common from './macpack/common.ts'
import * as Generic from './macpack/generic.ts'
import * as Longbranch from './macpack/longbranch.ts'
import * as Nes2header from './macpack/nes2header.ts'
import base64 from 'base64';

type Frame = [Tokens.Source|undefined, Token[][]];

const MAX_DEPTH = 100;

const MACPACK: Map<string, string> = new Map(
  [
    ['common', Common.text],
    ['generic', Generic.text],
    ['longbranch', Longbranch.text],
    ['nes2header', Nes2header.text],
  ]
);

export class TokenStream implements Tokens.Source {
  private stack: Frame[] = [];
  
  constructor(
    readonly readFile?: (path: string, filename: string) => Promise<string>,
    readonly readFileBinary?: (path: string, filename: string) => Promise<ArrayBuffer>,
    readonly opts?: Options) {}

  async loadFile<T>(path: string, action: (path: string, filename: string) => Promise<T>) {
    const paths = this.opts?.includePaths ?? ['./'];
    for (const base of paths) {
      try {
        console.log(`gonna try including base: ${base} path: ${path}`);
        return await action(base, path);
      } catch (_e) {
        // unable to load the files at that path.
      }
    }
    throw new Error(`Could not find file ${path} in include directories: ${paths.join(",")}`);
  }

  async next(): Promise<Token[]|undefined> {
    while (this.stack.length) {
      const [tok, front] = this.stack[this.stack.length - 1];
      if (front.length) return front.pop()!;
      const line = await tok?.next();
      if (line) {
        if (line?.[0].token !== 'cs') return line;
        switch (line[0].str) {
          case '.include': {
            const path = this.str(line);
            if (!this.readFile) this.err(line);
            // TODO - options?
            const code = await this.loadFile<string>(path, this.readFile);
            this.enter(new Tokenizer(code, path, this.opts));
            continue;
          }
          case '.macpack': {
            const pack = Tokens.expectIdentifier(line[1])?.toLowerCase();
            const code = MACPACK.get(pack) ?? this.err(line);
            this.enter(new Tokenizer(code, `${pack}.macpack`, this.opts));
            continue;
          }
          case '.incbin': {
            // TODO: consider moving this to an assembler directive so it can just put the
            // whole chunk of bytes into the module and skip tokenizing it.
            if (!this.readFileBinary) this.err(line);
            if (line.length < 1) {
              this.err(line);
            }
            const path = Tokens.expectString(line[1], line[0]);
            let offset = 0;
            let length = undefined;
            if (line.length > 2) {
              const args = Tokens.parseArgList(line, 2);
              if (args[1]) {
                const expr = Exprs.evaluate(Exprs.parseOnly(args[1]));
                offset = expr.num ?? 0;
              }
              if (args[2]) {
                const expr = Exprs.evaluate(Exprs.parseOnly(args[2]));
                length = expr.num ?? -1;
              }
            }
            // TODO this is a little jank, but we base64 encode the binary file for now
            // so it can be loaded faster without parsing later.
            const binary = await this.loadFile<ArrayBuffer>(path, this.readFileBinary);
            const end = length !== undefined ? offset + length : undefined;
            const bin = base64.fromArrayBuffer(binary.slice(offset, end));
            const out : Token[] = [
              Tokens.BYTESTR,
              {token: 'str', str: bin}
            ];
            return out;
          }
          default:
            return line;
        }
      }
      this.stack.pop();
    }
    return undefined;
  }

  unshift(...lines: Token[][]) {
    if (!this.stack.length) throw new Error(`Cannot unshift after EOF`);
    const front = this.stack[this.stack.length - 1][1];
    for (let i = lines.length - 1; i >= 0; i--) {
      front.push(lines[i]);
    }
  }

  // async include(file: string) {
  //   const code = await this.task.parent.readFile(file);
  //   this.stack.push([new Tokenizer(code, file, this.task.opts),  []]);
  // }
  // Enter a macro scope.
  enter(tokens?: Tokens.Source) {
    const frame: Frame = [undefined, []];
    if (tokens) frame[0] = tokens;
    this.stack.push(frame);
    if (this.stack.length > MAX_DEPTH) throw new Error(`Stack overflow`);
  }

  // Exit a macro scope prematurely.
  exit() {
    this.stack.pop();
  }
  // options(): Tokenizer.Options {
  //   return this.task.opts;
  // }
  
  err(line: Token[]): never {
    const msg = this.str(line);
    throw new Error(msg + Tokens.at(line[0]));
  }

  str(line: Token[]): string {
    const str = Tokens.expectString(line[1], line[0]);
    Tokens.expectEol(line[2], 'a single string');
    return str;
  }

}
