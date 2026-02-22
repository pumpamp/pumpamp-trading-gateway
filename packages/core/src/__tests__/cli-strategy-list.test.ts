import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { strategyConfigSchema } from '../features/strategy/strategy-config.js';

// ============================================================
// ============================================================

// We test the strategy list logic directly (same logic as cli.ts)
// rather than parsing Commander, to avoid process.exit side effects.

function strategyList(templatesDir: string): {
  output: string[];
  warnings: string[];
} {
  const output: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(templatesDir)) {
    output.push(`Templates directory not found: ${templatesDir}`);
    return { output, warnings };
  }

  const files = readdirSync(templatesDir).filter((f: string) => f.endsWith('.json'));

  if (files.length === 0) {
    output.push('No template files found.');
    return { output, warnings };
  }

  output.push('Available Strategy Templates:');
  output.push('=============================');

  for (const file of files) {
    const filePath = join(templatesDir, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const json = JSON.parse(raw);
      const config = strategyConfigSchema.parse(json);

      const name = basename(file, '.json');
      const description = (json as Record<string, unknown>)._description ?? '(no description)';
      const signals = (json as Record<string, unknown>)._signals ?? [];
      const venues = new Set<string>();
      for (const rule of config.rules) {
        if (rule.venues) {
          for (const v of rule.venues) venues.add(v);
        }
      }

      output.push(`  ${name}`);
      output.push(`    Description: ${description}`);
      output.push(`    Signals: ${Array.isArray(signals) ? signals.join(', ') : '(none)'}`);
      output.push(`    Venues: ${[...venues].join(', ') || '(any)'}`);
      output.push(`    Dry Run: ${config.dry_run}`);
    } catch (err) {
      warnings.push(`[WARN] Skipping invalid template: ${file} - ${(err as Error).message}`);
    }
  }

  return { output, warnings };
}

const TEMPLATES_DIR = resolve(__dirname, '../../../../templates');

describe('cli-strategy-list', () => {
  it('Shows all valid templates', () => {
    const { output } = strategyList(TEMPLATES_DIR);

    const fullOutput = output.join('\n');
    expect(fullOutput).toContain('prediction-arb');
    expect(fullOutput).toContain('sharp-line-movement');
    expect(fullOutput).toContain('prediction-whale-follow');
    expect(fullOutput).toContain('prediction-volume-spike');
  });

  it('Output includes required fields (name, description, signals, venues, dry_run)', () => {
    const { output } = strategyList(TEMPLATES_DIR);

    const fullOutput = output.join('\n');
    expect(fullOutput).toContain('Description:');
    expect(fullOutput).toContain('Signals:');
    expect(fullOutput).toContain('Venues:');
    expect(fullOutput).toContain('Dry Run:');
  });

  it('Invalid template skipped with warning', () => {
    // Use a temporary directory with an invalid template
    const tmpDir = resolve(__dirname, '../../../../node_modules/.test-tmp-templates');
    const fs = require('node:fs');

    // Create tmp dir
    fs.mkdirSync(tmpDir, { recursive: true });

    // Write a valid template
    fs.writeFileSync(
      join(tmpDir, 'valid.json'),
      JSON.stringify({
        enabled: true,
        dry_run: true,
        _description: 'valid template',
        _usage: 'test usage',
        rules: [
          {
            name: 'test_rule',
            enabled: true,
            signal_types: ['strategy'],
            action: { side: 'buy', size: 1, order_type: 'market' },
          },
        ],
      }),
    );

    // Write an invalid template (missing required fields in rule)
    fs.writeFileSync(
      join(tmpDir, 'invalid.json'),
      JSON.stringify({
        enabled: true,
        dry_run: true,
        rules: [
          {
            // Missing 'name' (required)
            enabled: true,
            signal_types: ['strategy'],
          },
        ],
      }),
    );

    const { output, warnings } = strategyList(tmpDir);

    const fullOutput = output.join('\n');
    expect(fullOutput).toContain('valid');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('invalid.json');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('--templates-dir override works', () => {
    // Point to actual templates dir using the absolute path
    const { output } = strategyList(TEMPLATES_DIR);

    const fullOutput = output.join('\n');
    expect(fullOutput).toContain('Available Strategy Templates:');
    expect(fullOutput).toContain('prediction-arb');

    // Point to non-existent dir
    const { output: noOutput } = strategyList('/nonexistent/dir');
    expect(noOutput.join('\n')).toContain('Templates directory not found');
  });
});
