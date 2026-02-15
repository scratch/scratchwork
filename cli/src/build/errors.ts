/**
 * Common MDX/JSX errors and their user-friendly explanations
 */
interface ErrorSourceLocation {
  filePath?: string;
  line?: number;
  column?: number;
  lineText?: string;
  jsxElement?: string;
  lineAppliesToSource?: boolean;
  renderEntryPath?: string;
  renderEntryLine?: number;
}

const ERROR_PATTERNS: Array<{
  pattern: RegExp;
  getMessage: (match: RegExpMatchArray, location?: ErrorSourceLocation) => string;
}> = [
  {
    pattern:
      /The `style` prop expects a mapping from style properties to values, not a string/,
    getMessage: (_, location) =>
      `MDX syntax error${formatSourceReference(location)}:\n` +
      `  HTML-style "style" attributes don't work in MDX.\n\n` +
      `  Instead of:  <div style="color: red">\n` +
      `  Use:         <div style={{color: 'red'}}>\n\n` +
      `  MDX uses JSX syntax, so style must be an object.` +
      formatSourceDetails(location),
  },
  {
    pattern: /Invalid DOM property `class`\. Did you mean `className`\?/,
    getMessage: (_, location) =>
      `MDX syntax error${formatSourceReference(location)}:\n` +
      `  HTML-style "class" attributes don't work in MDX.\n\n` +
      `  Instead of:  <div class="foo">\n` +
      `  Use:         <div className="foo">\n\n` +
      `  MDX uses JSX syntax, so use className instead of class.` +
      formatSourceDetails(location),
  },
  {
    pattern:
      /Element type is invalid: expected a string.*but got: (undefined|object)/,
    getMessage: (_, location) => {
      const elementHint = location?.jsxElement ? ` (${location.jsxElement})` : '';
      return (
        `MDX syntax error${formatSourceReference(location)}:\n` +
        `  A JSX element couldn't be rendered${elementHint}. Common causes:\n\n` +
        `  1. Unclosed HTML tag - use self-closing syntax:\n` +
        `     Instead of:  <img src="...">\n` +
        `     Use:         <img src="..." />\n\n` +
        `  2. Missing component - check the component name is correct\n` +
        `     and the file exists in src/ or pages/` +
        formatSourceDetails(location)
      );
    },
  },
  {
    pattern: /Expected corresponding JSX closing tag for <(\w+)>/,
    getMessage: (match, location) =>
      `MDX syntax error${formatSourceReference(location)}:\n` +
      `  Unclosed <${match[1]}> tag.\n\n` +
      `  Either close it: <${match[1]}>...</${match[1]}>\n` +
      `  Or self-close:   <${match[1]} />` +
      formatSourceDetails(location),
  },
  {
    pattern: /Unexpected token/,
    getMessage: (_, location) =>
      `MDX syntax error${formatSourceReference(location)}:\n` +
      `  Invalid JSX syntax. Check for:\n` +
      `  - Unclosed tags (use <img /> not <img>)\n` +
      `  - HTML attributes (use className not class)\n` +
      `  - Style attributes (use style={{}} not style="")` +
      formatSourceDetails(location),
  },
];

/**
 * Attempt to extract source file/line info from an error for better diagnostics.
 */
function extractSourceLocation(error: Error | string): ErrorSourceLocation | null {
  const errorStr =
    error instanceof Error
      ? [error.message, error.stack].filter((value): value is string => Boolean(value)).join('\n')
      : error;
  const location: ErrorSourceLocation = {};

  // Render errors include the source path directly in the message.
  // Example: "Failed to render docs/page.mdx: Element type is invalid..."
  let match = errorStr.match(/Failed to render\s+([^\n:]+\.(?:mdx|md))\s*:/);
  if (match?.[1]) {
    location.filePath = match[1];
  }

  // Matches stack-like output with a direct source path.
  match = errorStr.match(/([^\s:]+\.(?:mdx|md)):(\d+):(\d+)/);
  if (match?.[1]) {
    location.filePath ??= match[1];
    location.line = Number(match[2]);
    location.column = Number(match[3]);
    location.lineAppliesToSource = true;
  }

  // Bun build errors often embed line text in "line | content" style.
  const lineTextMatch = errorStr.match(/\n\s*(\d+)\s*\|\s*(.+)$/m);
  if (lineTextMatch) {
    location.line ??= Number(lineTextMatch[1]);
    location.lineText = lineTextMatch[2]!.trimEnd();
  }

  // Render step may include explicit location for the generated server entry.
  match = errorStr.match(/Render entry:\s*([^\s:]+)(?::(\d+))?/);
  if (match?.[1]) {
    location.renderEntryPath = match[1];
    if (match[2]) {
      location.renderEntryLine = Number(match[2]);
      location.line ??= location.renderEntryLine;
    }
  }

  // Look for paths in server-compiled or client-compiled directories
  match = errorStr.match(
    /(?:server-compiled|client-compiled)[\\/](.+?)[\\/]index\.js/
  );
  if (match?.[1]) {
    location.filePath ??= `pages/${match[1]}.mdx`;
  }

  // Try to capture the JSX element name for "Element type is invalid" style errors.
  // We prioritize explicit JSX tags in source snippets.
  if (!location.jsxElement && location.lineText) {
    const lineTagMatch = location.lineText.match(/<\/?([A-Za-z][\w.-]*)\b/);
    if (lineTagMatch?.[1]) {
      location.jsxElement = `<${lineTagMatch[1]}>`;
    }
  }

  if (!location.jsxElement) {
    const jsxClosingTagMatch = errorStr.match(
      /Expected corresponding JSX closing tag for <([A-Za-z][\w.-]*)>/
    );
    if (jsxClosingTagMatch?.[1]) {
      location.jsxElement = `<${jsxClosingTagMatch[1]}>`;
    }
  }

  if (!location.jsxElement) {
    const renderMethodMatch = errorStr.match(/Check the render method of `([^`]+)`/);
    if (renderMethodMatch?.[1]) {
      location.jsxElement = renderMethodMatch[1];
    }
  }

  // Keep anonymous line previews only for MDX-related errors.
  if (!location.filePath && location.lineText && !/mdx/i.test(errorStr)) {
    location.line = undefined;
    location.lineText = undefined;
  }

  if (
    location.filePath ||
    location.line !== undefined ||
    location.lineText ||
    location.jsxElement
  ) {
    return location;
  }
  return null;
}

function formatSourceReference(location?: ErrorSourceLocation | null): string {
  if (!location?.filePath) {
    return '';
  }

  const lineSuffix =
    location.line !== undefined && location.lineAppliesToSource === true
      ? `:${location.line}` + (location.column !== undefined ? `:${location.column}` : '')
      : '';
  return ` in ${location.filePath}${lineSuffix}`;
}

function formatSourceDetails(location?: ErrorSourceLocation | null): string {
  if (location?.renderEntryPath) {
    const line =
      location.renderEntryLine !== undefined
        ? `:${location.renderEntryLine}`
        : '';
    const linePreview =
      location.renderEntryLine !== undefined && location.lineText
        ? `\n  ${location.renderEntryLine} | ${location.lineText}`
        : '';
    return `\n\n  Render entry: ${location.renderEntryPath}${line}${linePreview}`;
  }

  if (location?.line === undefined) {
    return '';
  }

  if (location.lineText) {
    return `\n\n  ${location.line} | ${location.lineText}`;
  }

  const columnSuffix = location.column !== undefined ? `, column ${location.column}` : '';
  return `\n\n  Line ${location.line}${columnSuffix}`;
}

function formatAtReference(location: ErrorSourceLocation): string {
  const lineSuffix =
    location.line !== undefined && location.lineAppliesToSource === true
      ? `:${location.line}` + (location.column !== undefined ? `:${location.column}` : '')
      : '';
  return `${location.filePath}${lineSuffix}`;
}

function extractAdditionalRenderErrors(errorStr: string): string {
  const match = errorStr.match(/\n\s*Additional render errors \(\d+\):[\s\S]*$/);
  if (!match?.[0]) {
    return '';
  }
  return `\n\n${match[0].trimStart()}`;
}

/**
 * Transform build errors into more helpful messages
 */
export function formatBuildError(error: Error | string): string {
  const errorStr = error instanceof Error ? error.message : error;
  const sourceLocation = extractSourceLocation(error);
  const additionalRenderErrors = extractAdditionalRenderErrors(errorStr);

  for (const { pattern, getMessage } of ERROR_PATTERNS) {
    const match = errorStr.match(pattern);
    if (match) {
      return getMessage(match, sourceLocation) + additionalRenderErrors;
    }
  }

  if (sourceLocation?.filePath) {
    const atReference = formatAtReference(sourceLocation);
    const existingAtLine = `\n  at ${atReference}`;
    if (errorStr.includes(existingAtLine)) {
      return errorStr;
    }
    if (sourceLocation?.lineText && sourceLocation.line !== undefined) {
      return `${errorStr}\n  at ${atReference}:\n  ${sourceLocation.line} | ${sourceLocation.lineText}`;
    }
    return `${errorStr}\n  at ${atReference}`;
  }

  if (sourceLocation?.line !== undefined && sourceLocation.lineText) {
    return `${errorStr}\n  ${sourceLocation.line} | ${sourceLocation.lineText}`;
  }

  // Return original error if no pattern matched
  return errorStr;
}
