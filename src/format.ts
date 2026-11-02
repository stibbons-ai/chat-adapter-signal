import { BaseFormatConverter, paragraph, root, text, toPlainText, type Root } from "chat";

/**
 * Plain-text Signal format. Signal carries styling as separate `textStyle`
 * ranges, not inline markup, so inbound text is taken literally and outbound
 * markdown is reduced to its plain text until text styles are supported.
 */
export class SignalFormatConverter extends BaseFormatConverter {
  fromAst(ast: Root): string {
    return toPlainText(ast);
  }

  toAst(platformText: string): Root {
    return root([paragraph([text(platformText)])]);
  }
}
