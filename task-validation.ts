/**
 * Task Validation Utilities
 *
 * Provides validation for task metadata fields to ensure data integrity.
 * Use these utilities when creating or updating tasks to validate user input.
 */

import type {
  TaskCategory,
  TaskComplexity,
  TaskImpact,
  TaskPriority,
  ModelType,
  ThinkingLevel,
} from '../types/task';

/**
 * Result of a validation operation
 */
export interface ValidationResult {
  /** Whether the validation passed */
  valid: boolean;
  /** Error messages if validation failed */
  errors: string[];
}

/**
 * Validation constants for task fields
 */
export const VALIDATION_CONSTANTS = {
  /** Title validation */
  TITLE: {
    MIN_LENGTH: 3,
    MAX_LENGTH: 200,
    PATTERN: /^[\s\S]*$/,  // Allow any characters including newlines
  },

  /** Description validation */
  DESCRIPTION: {
    MIN_LENGTH: 10,
    MAX_LENGTH: 10000,
  },

  /** Rationale validation */
  RATIONALE: {
    MAX_LENGTH: 2000,
  },

  /** Problem solved validation */
  PROBLEM_SOLVED: {
    MAX_LENGTH: 2000,
  },

  /** Target audience validation */
  TARGET_AUDIENCE: {
    MAX_LENGTH: 500,
  },

  /** File path validation */
  FILE_PATH: {
    MAX_LENGTH: 500,
    // Validate that paths don't contain suspicious patterns
    ALLOWED_PATTERN: /^[a-zA-Z0-9\/_\-. ]+$/,
  },

  /** Dependency validation */
  DEPENDENCY: {
    MAX_LENGTH: 200,
  },

  /** Array limits */
  ARRAYS: {
    MAX_AFFECTED_FILES: 100,
    MAX_DEPENDENCIES: 50,
    MAX_TAGS: 20,
    MAX_ATTACHMENTS: 20,
  },

  /** Tag validation */
  TAG: {
    MIN_LENGTH: 1,
    MAX_LENGTH: 50,
    PATTERN: /^[a-zA-Z0-9\-_]+$/,
  },
} as const;

/**
 * Valid task categories
 */
export const VALID_CATEGORIES: readonly TaskCategory[] = [
  'feature',
  'bug_fix',
  'refactoring',
  'documentation',
  'security',
  'performance',
  'ui_ux',
  'infrastructure',
  'testing',
] as const;

/**
 * Valid task complexity levels
 */
export const VALID_COMPLEXITY_LEVELS: readonly TaskComplexity[] = [
  'trivial',
  'small',
  'medium',
  'large',
  'complex',
] as const;

/**
 * Valid task impact levels
 */
export const VALID_IMPACT_LEVELS: readonly TaskImpact[] = [
  'low',
  'medium',
  'high',
  'critical',
] as const;

/**
 * Valid task priority levels
 */
export const VALID_PRIORITY_LEVELS: readonly TaskPriority[] = [
  'low',
  'medium',
  'high',
  'urgent',
] as const;

/**
 * Valid model types
 */
export const VALID_MODEL_TYPES: readonly ModelType[] = [
  'haiku',
  'sonnet',
  'opus',
] as const;

/**
 * Valid thinking levels
 */
export const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'none',
  'low',
  'medium',
  'high',
] as const;

/**
 * Validate a task title
 *
 * @param title - The title to validate
 * @returns Validation result with any error messages
 */
export function validateTitle(title: string): ValidationResult {
  const errors: string[] = [];

  if (!title || title.trim().length === 0) {
    errors.push('Title is required');
  } else if (title.length < VALIDATION_CONSTANTS.TITLE.MIN_LENGTH) {
    errors.push(`Title must be at least ${VALIDATION_CONSTANTS.TITLE.MIN_LENGTH} characters`);
  } else if (title.length > VALIDATION_CONSTANTS.TITLE.MAX_LENGTH) {
    errors.push(`Title must not exceed ${VALIDATION_CONSTANTS.TITLE.MAX_LENGTH} characters`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a task description
 *
 * @param description - The description to validate
 * @returns Validation result with any error messages
 */
export function validateDescription(description: string): ValidationResult {
  const errors: string[] = [];

  if (!description || description.trim().length === 0) {
    errors.push('Description is required');
  } else if (description.length < VALIDATION_CONSTANTS.DESCRIPTION.MIN_LENGTH) {
    errors.push(`Description must be at least ${VALIDATION_CONSTANTS.DESCRIPTION.MIN_LENGTH} characters`);
  } else if (description.length > VALIDATION_CONSTANTS.DESCRIPTION.MAX_LENGTH) {
    errors.push(`Description must not exceed ${VALIDATION_CONSTANTS.DESCRIPTION.MAX_LENGTH} characters`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a task category
 *
 * @param category - The category to validate
 * @returns Validation result with any error messages
 */
export function validateCategory(category: string | undefined): ValidationResult {
  const errors: string[] = [];

  if (category && !VALID_CATEGORIES.includes(category as TaskCategory)) {
    errors.push(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate task complexity
 *
 * @param complexity - The complexity to validate
 * @returns Validation result with any error messages
 */
export function validateComplexity(complexity: string | undefined): ValidationResult {
  const errors: string[] = [];

  if (complexity && !VALID_COMPLEXITY_LEVELS.includes(complexity as TaskComplexity)) {
    errors.push(`Invalid complexity. Must be one of: ${VALID_COMPLEXITY_LEVELS.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate task impact
 *
 * @param impact - The impact to validate
 * @returns Validation result with any error messages
 */
export function validateImpact(impact: string | undefined): ValidationResult {
  const errors: string[] = [];

  if (impact && !VALID_IMPACT_LEVELS.includes(impact as TaskImpact)) {
    errors.push(`Invalid impact. Must be one of: ${VALID_IMPACT_LEVELS.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate task priority
 *
 * @param priority - The priority to validate
 * @returns Validation result with any error messages
 */
export function validatePriority(priority: string | undefined): ValidationResult {
  const errors: string[] = [];

  if (priority && !VALID_PRIORITY_LEVELS.includes(priority as TaskPriority)) {
    errors.push(`Invalid priority. Must be one of: ${VALID_PRIORITY_LEVELS.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate model type
 *
 * @param model - The model type to validate
 * @returns Validation result with any error messages
 */
export function validateModel(model: string | undefined): ValidationResult {
  const errors: string[] = [];

  if (model && !VALID_MODEL_TYPES.includes(model as ModelType)) {
    errors.push(`Invalid model. Must be one of: ${VALID_MODEL_TYPES.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate thinking level
 *
 * @param thinkingLevel - The thinking level to validate
 * @returns Validation result with any error messages
 */
export function validateThinkingLevel(thinkingLevel: string | undefined): ValidationResult {
  const errors: string[] = [];

  if (thinkingLevel && !VALID_THINKING_LEVELS.includes(thinkingLevel as ThinkingLevel)) {
    errors.push(`Invalid thinking level. Must be one of: ${VALID_THINKING_LEVELS.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a file path
 *
 * @param path - The file path to validate
 * @returns Validation result with any error messages
 */
export function validateFilePath(path: string): ValidationResult {
  const errors: string[] = [];

  if (!path || path.trim().length === 0) {
    errors.push('File path cannot be empty');
  } else if (path.length > VALIDATION_CONSTANTS.FILE_PATH.MAX_LENGTH) {
    errors.push(`File path must not exceed ${VALIDATION_CONSTANTS.FILE_PATH.MAX_LENGTH} characters`);
  } else if (!VALIDATION_CONSTANTS.FILE_PATH.ALLOWED_PATTERN.test(path)) {
    errors.push('File path contains invalid characters');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate an array of file paths
 *
 * @param paths - The file paths to validate
 * @returns Validation result with any error messages
 */
export function validateFilePaths(paths: string[] | undefined): ValidationResult {
  const errors: string[] = [];

  if (!paths) {
    return { valid: true, errors: [] };
  }

  if (paths.length > VALIDATION_CONSTANTS.ARRAYS.MAX_AFFECTED_FILES) {
    errors.push(`Cannot have more than ${VALIDATION_CONSTANTS.ARRAYS.MAX_AFFECTED_FILES} affected files`);
  }

  paths.forEach((path, index) => {
    const result = validateFilePath(path);
    if (!result.valid) {
      errors.push(`File path ${index + 1}: ${result.errors.join(', ')}`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a tag
 *
 * @param tag - The tag to validate
 * @returns Validation result with any error messages
 */
export function validateTag(tag: string): ValidationResult {
  const errors: string[] = [];

  if (!tag || tag.trim().length === 0) {
    errors.push('Tag cannot be empty');
  } else if (tag.length < VALIDATION_CONSTANTS.TAG.MIN_LENGTH) {
    errors.push(`Tag must be at least ${VALIDATION_CONSTANTS.TAG.MIN_LENGTH} character`);
  } else if (tag.length > VALIDATION_CONSTANTS.TAG.MAX_LENGTH) {
    errors.push(`Tag must not exceed ${VALIDATION_CONSTANTS.TAG.MAX_LENGTH} characters`);
  } else if (!VALIDATION_CONSTANTS.TAG.PATTERN.test(tag)) {
    errors.push('Tag can only contain letters, numbers, hyphens, and underscores');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate an array of tags
 *
 * @param tags - The tags to validate
 * @returns Validation result with any error messages
 */
export function validateTags(tags: string[] | undefined): ValidationResult {
  const errors: string[] = [];

  if (!tags) {
    return { valid: true, errors: [] };
  }

  if (tags.length > VALIDATION_CONSTANTS.ARRAYS.MAX_TAGS) {
    errors.push(`Cannot have more than ${VALIDATION_CONSTANTS.ARRAYS.MAX_TAGS} tags`);
  }

  // Check for duplicates
  const uniqueTags = new Set(tags);
  if (uniqueTags.size !== tags.length) {
    errors.push('Duplicate tags are not allowed');
  }

  tags.forEach((tag, index) => {
    const result = validateTag(tag);
    if (!result.valid) {
      errors.push(`Tag ${index + 1}: ${result.errors.join(', ')}`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a text field with optional length constraints
 *
 * @param value - The text value to validate
 * @param fieldName - The name of the field (for error messages)
 * @param maxLength - Maximum allowed length
 * @param required - Whether the field is required
 * @returns Validation result with any error messages
 */
export function validateTextField(
  value: string | undefined,
  fieldName: string,
  maxLength: number,
  required: boolean = false
): ValidationResult {
  const errors: string[] = [];

  if (required && (!value || value.trim().length === 0)) {
    errors.push(`${fieldName} is required`);
  } else if (value && value.length > maxLength) {
    errors.push(`${fieldName} must not exceed ${maxLength} characters`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Create a successful validation result
 *
 * @returns A validation result indicating success
 */
export function validationSuccess(): ValidationResult {
  return {
    valid: true,
    errors: [],
  };
}

/**
 * Create a failed validation result
 *
 * @param errors - Error messages
 * @returns A validation result indicating failure
 */
export function validationFailure(...errors: string[]): ValidationResult {
  return {
    valid: false,
    errors,
  };
}

/**
 * Combine multiple validation results
 *
 * @param results - Validation results to combine
 * @returns A single validation result with all errors
 */
export function combineValidationResults(...results: ValidationResult[]): ValidationResult {
  const allErrors = results.flatMap(r => r.errors);

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
  };
}
