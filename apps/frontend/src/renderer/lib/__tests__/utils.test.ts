/**
 * Unit tests for lib/utils utility functions
 * Tests elapsed time calculation and duration formatting
 */
import { describe, it, expect } from 'vitest';
import {
  formatElapsedFromTimestamp,
  formatDuration,
  STALE_THRESHOLD_MS,
  CLOCK_SKEW_TOLERANCE_MS,
  calculateProgress,
  formatRelativeTime,
  sanitizeMarkdownForDisplay
} from '../utils';

describe('formatDuration', () => {
  it('should format 0 milliseconds as "0s"', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('should format seconds correctly', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(59000)).toBe('59s');
  });

  it('should format minutes and seconds correctly', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(61000)).toBe('1m 1s');
    expect(formatDuration(135000)).toBe('2m 15s');
    expect(formatDuration(3599000)).toBe('59m 59s');
  });

  it('should format hours and minutes correctly (no seconds for long durations)', () => {
    expect(formatDuration(3600000)).toBe('1h 0m');
    expect(formatDuration(3661000)).toBe('1h 1m'); // seconds dropped for hour+ durations
    expect(formatDuration(5400000)).toBe('1h 30m');
    expect(formatDuration(7200000)).toBe('2h 0m');
  });

  it('should format days, hours, and minutes correctly', () => {
    expect(formatDuration(86400000)).toBe('1d 0h 0m');
    expect(formatDuration(90000000)).toBe('1d 1h 0m');
    expect(formatDuration(93600000)).toBe('1d 2h 0m');
    expect(formatDuration(172800000)).toBe('2d 0h 0m');
  });

  it('should handle negative values by returning "0s"', () => {
    expect(formatDuration(-1000)).toBe('0s');
    expect(formatDuration(-60000)).toBe('0s');
  });
});

describe('formatElapsedFromTimestamp', () => {
  // Use a fixed "now" time for consistent testing
  const fixedNow = 1704067200000; // 2024-01-01 00:00:00 UTC

  describe('basic elapsed time calculation', () => {
    it('should calculate elapsed time correctly for recent timestamp', () => {
      const timestamp = new Date(fixedNow - 5000); // 5 seconds ago
      const result = formatElapsedFromTimestamp(timestamp, fixedNow);

      expect(result.formatted).toBe('5s');
      expect(result.elapsedMs).toBe(5000);
      expect(result.isStale).toBe(false);
      expect(result.isInvalid).toBe(false);
    });

    it('should handle timestamp as ISO string', () => {
      const timestamp = new Date(fixedNow - 60000).toISOString(); // 1 minute ago
      const result = formatElapsedFromTimestamp(timestamp, fixedNow);

      expect(result.formatted).toBe('1m 0s');
      expect(result.elapsedMs).toBe(60000);
      expect(result.isStale).toBe(false);
    });

    it('should format 2 minutes 15 seconds correctly', () => {
      const timestamp = new Date(fixedNow - 135000);
      const result = formatElapsedFromTimestamp(timestamp, fixedNow);

      expect(result.formatted).toBe('2m 15s');
      expect(result.elapsedMs).toBe(135000);
    });

    it('should handle exactly 0 elapsed time', () => {
      const timestamp = new Date(fixedNow);
      const result = formatElapsedFromTimestamp(timestamp, fixedNow);

      expect(result.formatted).toBe('0s');
      expect(result.elapsedMs).toBe(0);
      expect(result.isStale).toBe(false);
    });
  });

  describe('stale timestamp detection', () => {
    it('should mark timestamp as stale when > 5 minutes old', () => {
      const sixMinutesMs = 6 * 60 * 1000;
      const timestamp = new Date(fixedNow - sixMinutesMs);
      const result = formatElapsedFromTimestamp(timestamp, fixedNow);

      expect(result.isStale).toBe(true);
      expect(result.formatted).toBe('6m 0s');
    });

    it('should not mark timestamp as stale when exactly 5 minutes old', () => {
      const timestamp = new Date(fixedNow - STALE_THRESHOLD_MS);
      const result = formatElapsedFromTimestamp(timestamp, fixedNow);

      expect(result.isStale).toBe(false);
    });

    it('should mark very old timestamp as stale', () => {
      const oneHourMs = 60 * 60 * 1000;
      const timestamp = new Date(fixedNow - oneHourMs);
      const result = formatElapsedFromTimestamp(timestamp, fixedNow);

      expect(result.isStale).toBe(true);
      expect(result.formatted).toBe('1h 0m');
    });
  });

  describe('invalid timestamp handling', () => {
    it('should handle null timestamp', () => {
      const result = formatElapsedFromTimestamp(null, fixedNow);

      expect(result.formatted).toBe('--');
      expect(result.elapsedMs).toBe(0);
      expect(result.isStale).toBe(true);
      expect(result.isInvalid).toBe(true);
    });

    it('should handle undefined timestamp', () => {
      const result = formatElapsedFromTimestamp(undefined, fixedNow);

      expect(result.formatted).toBe('--');
      expect(result.isInvalid).toBe(true);
    });

    it('should handle invalid date string', () => {
      const result = formatElapsedFromTimestamp('not-a-date', fixedNow);

      expect(result.formatted).toBe('--');
      expect(result.isInvalid).toBe(true);
    });

    it('should handle Invalid Date object', () => {
      const result = formatElapsedFromTimestamp(new Date('invalid'), fixedNow);

      expect(result.formatted).toBe('--');
      expect(result.isInvalid).toBe(true);
    });
  });

  describe('clock skew handling', () => {
    it('should handle small negative elapsed time (minor clock skew)', () => {
      // Timestamp 1 second in future - should be treated as 0
      const timestamp = new Date(fixedNow + 1000);
      const result = formatElapsedFromTimestamp(timestamp, fixedNow);

      expect(result.formatted).toBe('0s');
      expect(result.elapsedMs).toBe(0);
      expect(result.isInvalid).toBe(false);
    });

    it('should handle timestamp at clock skew tolerance boundary', () => {
      // Timestamp exactly at tolerance (5 min in future)
      const timestamp = new Date(fixedNow + CLOCK_SKEW_TOLERANCE_MS);
      const result = formatElapsedFromTimestamp(timestamp, fixedNow);

      expect(result.formatted).toBe('0s');
      expect(result.isInvalid).toBe(false);
    });

    it('should mark timestamp as invalid when too far in future', () => {
      // Timestamp 10 minutes in future - beyond tolerance
      const tenMinutesMs = 10 * 60 * 1000;
      const timestamp = new Date(fixedNow + tenMinutesMs);
      const result = formatElapsedFromTimestamp(timestamp, fixedNow);

      expect(result.formatted).toBe('--');
      expect(result.isInvalid).toBe(true);
      expect(result.isStale).toBe(false);
    });
  });

  describe('long duration formatting', () => {
    it('should format hours correctly', () => {
      const twoHoursMs = 2 * 60 * 60 * 1000;
      const timestamp = new Date(fixedNow - twoHoursMs);
      const result = formatElapsedFromTimestamp(timestamp, fixedNow);

      expect(result.formatted).toBe('2h 0m');
      expect(result.isStale).toBe(true);
    });

    it('should format days correctly', () => {
      const oneDayMs = 24 * 60 * 60 * 1000;
      const timestamp = new Date(fixedNow - oneDayMs);
      const result = formatElapsedFromTimestamp(timestamp, fixedNow);

      expect(result.formatted).toBe('1d 0h 0m');
    });
  });

  describe('real-time usage (no fixed now)', () => {
    it('should work without explicit now parameter', () => {
      // This test verifies the function works with Date.now()
      const recentTimestamp = new Date(Date.now() - 2000); // 2 seconds ago
      const result = formatElapsedFromTimestamp(recentTimestamp);

      // Should be approximately 2 seconds (allow for test execution time)
      expect(result.elapsedMs).toBeGreaterThanOrEqual(2000);
      expect(result.elapsedMs).toBeLessThan(5000);
      expect(result.isStale).toBe(false);
      expect(result.isInvalid).toBe(false);
    });
  });
});

describe('calculateProgress', () => {
  it('should return 0 for empty array', () => {
    expect(calculateProgress([])).toBe(0);
  });

  it('should return 0 when no tasks completed', () => {
    const subtasks = [
      { status: 'pending' },
      { status: 'in_progress' },
      { status: 'pending' }
    ];
    expect(calculateProgress(subtasks)).toBe(0);
  });

  it('should return 100 when all tasks completed', () => {
    const subtasks = [
      { status: 'completed' },
      { status: 'completed' },
      { status: 'completed' }
    ];
    expect(calculateProgress(subtasks)).toBe(100);
  });

  it('should calculate partial progress correctly', () => {
    const subtasks = [
      { status: 'completed' },
      { status: 'pending' },
      { status: 'pending' },
      { status: 'pending' }
    ];
    expect(calculateProgress(subtasks)).toBe(25);
  });

  it('should round progress to nearest integer', () => {
    const subtasks = [
      { status: 'completed' },
      { status: 'pending' },
      { status: 'pending' }
    ];
    // 1/3 = 33.33...% -> rounds to 33
    expect(calculateProgress(subtasks)).toBe(33);
  });
});

describe('formatRelativeTime', () => {
  it('should return "just now" for very recent dates', () => {
    const now = new Date();
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('should format minutes ago correctly', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatRelativeTime(fiveMinutesAgo)).toBe('5m ago');
  });

  it('should format hours ago correctly', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(formatRelativeTime(twoHoursAgo)).toBe('2h ago');
  });

  it('should format days ago correctly', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(threeDaysAgo)).toBe('3d ago');
  });
});

describe('sanitizeMarkdownForDisplay', () => {
  it('should return empty string for empty input', () => {
    expect(sanitizeMarkdownForDisplay('')).toBe('');
  });

  it('should remove markdown headers', () => {
    expect(sanitizeMarkdownForDisplay('# Header')).toBe('Header');
    expect(sanitizeMarkdownForDisplay('## Subheader')).toBe('Subheader');
  });

  it('should remove bold markers', () => {
    expect(sanitizeMarkdownForDisplay('**bold text**')).toBe('bold text');
  });

  it('should remove inline code markers', () => {
    expect(sanitizeMarkdownForDisplay('some `code` here')).toBe('some code here');
  });

  it('should truncate long text', () => {
    const longText = 'a'.repeat(300);
    const result = sanitizeMarkdownForDisplay(longText, 200);
    expect(result.length).toBe(203); // 200 + '...'
    expect(result.endsWith('...')).toBe(true);
  });
});
