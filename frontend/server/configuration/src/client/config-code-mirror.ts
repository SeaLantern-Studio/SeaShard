import type { ServerConfigurationFileKind } from "@seashard/contracts";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";

interface ConfigurationStreamState {
  inBlockComment: boolean;
  inValue: boolean;
}

export const configurationHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "var(--sl-text-tertiary)", fontStyle: "italic" },
  { tag: tags.propertyName, color: "var(--sl-primary-dark)", fontWeight: "600" },
  { tag: tags.definitionOperator, color: "var(--sl-text-secondary)" },
  { tag: tags.string, color: "color-mix(in srgb, var(--sl-success) 82%, var(--sl-text-primary))" },
  { tag: tags.number, color: "var(--sl-warning)" },
  { tag: tags.bool, color: "var(--sl-success)" },
  { tag: tags.null, color: "var(--sl-error)" },
  { tag: [tags.bracket, tags.separator], color: "var(--sl-text-secondary)" },
]);

export const configurationSyntaxHighlighting = syntaxHighlighting(configurationHighlightStyle);

function createConfigurationLanguage(kind: ServerConfigurationFileKind) {
  return StreamLanguage.define<ConfigurationStreamState>({
    startState: () => ({ inBlockComment: false, inValue: false }),
    token(stream, state) {
      if (stream.sol()) state.inValue = false;

      if (state.inBlockComment) {
        if (stream.skipTo("*/")) {
          stream.match("*/");
          state.inBlockComment = false;
        } else {
          stream.skipToEnd();
        }
        return "comment";
      }

      if (stream.eatSpace()) return null;

      const first = stream.peek();
      if (
        (first === "#" && kind !== "json") ||
        (first === "!" && kind === "properties") ||
        (first === ";" && (kind === "properties" || kind === "toml" || kind === "text"))
      ) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match("//")) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match("/*")) {
        state.inBlockComment = true;
        if (stream.skipTo("*/")) {
          stream.match("*/");
          state.inBlockComment = false;
        } else {
          stream.skipToEnd();
        }
        return "comment";
      }

      if (kind === "toml" && stream.sol() && stream.match(/\[[^\]]+\]/u)) return "key";

      if (first === '"' || (first === "'" && kind !== "json")) {
        const quote = stream.next();
        let escaped = false;
        while (!stream.eol()) {
          const character = stream.next();
          if (character === quote && !escaped) break;
          escaped = character === "\\" && !escaped;
          if (character !== "\\") escaped = false;
        }
        return kind === "json" && stream.match(/^\s*:/u, false) ? "key" : "string";
      }

      if (
        !state.inValue &&
        kind !== "json" &&
        stream.match(kind === "properties" ? /[^=:#]+(?=\s*[=:])/u : /[^=:#]+(?=\s*[=:])/u)
      ) {
        return "key";
      }

      if (stream.match(/(?:true|false)\b/iu)) return "boolean";
      if (stream.match(/(?:null|nil)\b/iu)) return "null";
      if (stream.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\b/iu)) return "number";

      if (stream.match(/[:=]/u)) {
        state.inValue = true;
        return "operator";
      }
      if (first && "{}[]".includes(first)) {
        stream.next();
        return "bracket";
      }
      if (first && ",-".includes(first)) {
        stream.next();
        return "separator";
      }

      stream.next();
      stream.eatWhile((character) => !/\s/u.test(character) && !":=,{}[]#;".includes(character));
      return null;
    },
    tokenTable: {
      comment: tags.comment,
      key: tags.propertyName,
      operator: tags.definitionOperator,
      string: tags.string,
      number: tags.number,
      boolean: tags.bool,
      null: tags.null,
      bracket: tags.bracket,
      separator: tags.separator,
    },
  });
}

const configurationLanguages: Record<ServerConfigurationFileKind, Extension> = {
  properties: createConfigurationLanguage("properties"),
  yaml: createConfigurationLanguage("yaml"),
  json: createConfigurationLanguage("json"),
  toml: createConfigurationLanguage("toml"),
  text: createConfigurationLanguage("text"),
};

export function configurationLanguage(kind: ServerConfigurationFileKind): Extension {
  return configurationLanguages[kind];
}
