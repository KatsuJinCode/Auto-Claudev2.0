/**
 * Tests for quoteArgsForShell - ensures paths with spaces are properly quoted
 * for Windows shell mode (cmd.exe)
 */
import { describe, it, expect } from 'vitest';
import { quoteArgsForShell } from '../agent/agent-process';

describe('quoteArgsForShell', () => {
  describe('when shell mode is disabled', () => {
    it('should return args unchanged', () => {
      const args = ['python', '-u', 'C:\\path with spaces\\script.py'];
      const result = quoteArgsForShell(args, false);
      expect(result).toEqual(args);
    });

    it('should not quote even when args contain spaces', () => {
      const args = ['C:\\Users\\john doe\\scripts\\run.py', '--arg', 'value with spaces'];
      const result = quoteArgsForShell(args, false);
      expect(result).toEqual(args);
    });
  });

  describe('when shell mode is enabled', () => {
    it('should quote arguments containing spaces', () => {
      const args = ['python', '-u', 'C:\\path with spaces\\script.py'];
      const result = quoteArgsForShell(args, true);
      expect(result).toEqual(['python', '-u', '"C:\\path with spaces\\script.py"']);
    });

    it('should not quote arguments without spaces', () => {
      const args = ['python', '-u', 'C:\\simple\\script.py'];
      const result = quoteArgsForShell(args, true);
      expect(result).toEqual(args);
    });

    it('should handle multiple arguments with spaces', () => {
      const args = [
        'C:\\Program Files\\Python\\python.exe',
        '-u',
        'C:\\Users\\john doe\\script.py',
        '--output',
        'C:\\My Documents\\output.txt'
      ];
      const result = quoteArgsForShell(args, true);
      expect(result).toEqual([
        '"C:\\Program Files\\Python\\python.exe"',
        '-u',
        '"C:\\Users\\john doe\\script.py"',
        '--output',
        '"C:\\My Documents\\output.txt"'
      ]);
    });

    it('should handle real-world Auto-Claude paths', () => {
      // This is the actual failing case from production
      const args = [
        '-u',
        'C:\\Users\\jpswi\\personal projects\\Auto-Claude\\apps\\backend\\runners\\spec_runner.py',
        '--spec-id',
        '004-ui-state-reliability'
      ];
      const result = quoteArgsForShell(args, true);
      expect(result).toEqual([
        '-u',
        '"C:\\Users\\jpswi\\personal projects\\Auto-Claude\\apps\\backend\\runners\\spec_runner.py"',
        '--spec-id',
        '004-ui-state-reliability'
      ]);
    });

    it('should handle empty args array', () => {
      const result = quoteArgsForShell([], true);
      expect(result).toEqual([]);
    });
  });
});
