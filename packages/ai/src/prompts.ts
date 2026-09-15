/**
 * Prompts are versioned files referenced as `matching.adjudicate@v3`, and the
 * version is stamped on every `ai_runs` row. Prompts inline in code cannot be
 * diffed against quality: you need to be able to answer "did v4 help?" with
 * evidence, and that requires knowing which one ran.
 */

export interface PromptTemplate {
  name: string;
  version: string;
  system?: string;
  /** `{{placeholder}}` is substituted from the variables passed at render. */
  template: string;
}

export interface RenderedPrompt {
  ref: string;
  system?: string;
  prompt: string;
}

export class PromptRegistry {
  private readonly byRef = new Map<string, PromptTemplate>();

  register(template: PromptTemplate): this {
    this.byRef.set(`${template.name}@${template.version}`, template);
    return this;
  }

  get(ref: string): PromptTemplate {
    const found = this.byRef.get(ref);
    if (!found) {
      throw new Error(
        `unknown prompt ${ref} — registered: ${[...this.byRef.keys()].join(", ") || "none"}`,
      );
    }
    return found;
  }

  render(ref: string, variables: Record<string, string> = {}): RenderedPrompt {
    const template = this.get(ref);
    const substitute = (text: string): string =>
      text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        const value = variables[key];
        // An unreplaced placeholder means a caller forgot a variable, and a
        // prompt that silently contains "{{pairName}}" is a quality bug that
        // is very hard to see in an output.
        if (value === undefined) {
          throw new Error(`prompt ${ref} needs a value for {{${key}}}`);
        }
        return value;
      });

    return {
      ref,
      ...(template.system ? { system: substitute(template.system) } : {}),
      prompt: substitute(template.template),
    };
  }
}
