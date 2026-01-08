"""
Spec Dependency Module
======================

Functions for managing dependencies between specs.
Allows specs to declare dependencies on other specs, preventing builds
from starting until dependencies are merged.
"""

import json
from pathlib import Path


def load_dependencies(spec_dir: Path) -> list[str]:
    """
    Load the depends_on list from a spec's requirements.json.

    Args:
        spec_dir: Directory containing the spec files

    Returns:
        List of spec IDs that this spec depends on, or empty list if none
    """
    requirements_file = spec_dir / "requirements.json"

    if not requirements_file.exists():
        return []

    try:
        with open(requirements_file) as f:
            requirements = json.load(f)
        return requirements.get("depends_on", [])
    except (OSError, json.JSONDecodeError):
        return []


def get_spec_status(spec_dir: Path) -> str:
    """
    Get the current status of a spec.

    Args:
        spec_dir: Directory containing the spec files

    Returns:
        Status string: 'merged', 'complete', 'in_progress', or 'pending'
    """
    plan_file = spec_dir / "implementation_plan.json"

    if not plan_file.exists():
        return "pending"

    try:
        with open(plan_file) as f:
            plan = json.load(f)

        # Check if explicitly marked as merged
        if plan.get("status") == "merged":
            return "merged"

        # Count subtask completion
        total = 0
        completed = 0

        for phase in plan.get("phases", []):
            for subtask in phase.get("subtasks", []):
                total += 1
                if subtask.get("status") == "completed":
                    completed += 1

        if total == 0:
            return "pending"
        elif completed == total:
            return "complete"
        elif completed > 0:
            return "in_progress"
        else:
            return "pending"

    except (OSError, json.JSONDecodeError):
        return "pending"


def is_spec_merged_or_complete(spec_dir: Path) -> bool:
    """
    Check if a spec is merged or has all subtasks completed.

    Args:
        spec_dir: Directory containing the spec files

    Returns:
        True if the spec is merged or all subtasks are complete
    """
    status = get_spec_status(spec_dir)
    return status in ("merged", "complete")


def find_spec_dir(project_dir: Path, spec_id: str) -> Path | None:
    """
    Find a spec directory by its ID.

    Args:
        project_dir: Project root directory
        spec_id: Spec identifier (e.g., '001-my-feature' or 'my-feature')

    Returns:
        Path to the spec directory, or None if not found
    """
    specs_dir = project_dir / ".auto-claude" / "specs"

    if not specs_dir.exists():
        return None

    # Try exact match first
    exact_path = specs_dir / spec_id
    if exact_path.exists() and exact_path.is_dir():
        return exact_path

    # Try finding by suffix (name without number prefix)
    for item in specs_dir.iterdir():
        if item.is_dir():
            # Match by full name or by the part after the number prefix
            name = item.name
            if name == spec_id:
                return item
            # Handle '001-my-feature' style IDs - match against 'my-feature'
            if "-" in name and name.split("-", 1)[1] == spec_id:
                return item
            # Also try matching spec_id as the full name pattern
            if spec_id.endswith(name.split("-", 1)[-1]):
                return item

    return None


def check_unmet_dependencies(project_dir: Path, spec_dir: Path) -> list[dict]:
    """
    Check which dependencies of a spec are not yet complete.

    Args:
        project_dir: Project root directory
        spec_dir: Directory containing the spec to check

    Returns:
        List of dicts with unmet dependency info:
        [{"spec_id": str, "status": str, "reason": str}, ...]
        Empty list if all dependencies are met
    """
    dependencies = load_dependencies(spec_dir)

    if not dependencies:
        return []

    unmet = []

    for dep_id in dependencies:
        dep_dir = find_spec_dir(project_dir, dep_id)

        if dep_dir is None:
            unmet.append(
                {
                    "spec_id": dep_id,
                    "status": "not_found",
                    "reason": f"Dependency spec '{dep_id}' does not exist",
                }
            )
            continue

        if not is_spec_merged_or_complete(dep_dir):
            status = get_spec_status(dep_dir)
            unmet.append(
                {
                    "spec_id": dep_id,
                    "status": status,
                    "reason": f"Dependency spec '{dep_id}' is not yet complete (status: {status})",
                }
            )

    return unmet


def detect_circular_dependencies(
    project_dir: Path,
    spec_id: str,
    visited: set[str] | None = None,
    path: list[str] | None = None,
) -> list[str] | None:
    """
    Detect if adding dependencies would create a circular dependency.

    Uses depth-first search to detect cycles in the dependency graph.

    Args:
        project_dir: Project root directory
        spec_id: The spec ID to check
        visited: Set of already visited spec IDs (used internally)
        path: Current path being explored (used internally)

    Returns:
        List representing the circular path if found (e.g., ['A', 'B', 'C', 'A']),
        or None if no circular dependency exists
    """
    if visited is None:
        visited = set()
    if path is None:
        path = []

    # Check for cycle
    if spec_id in path:
        # Found a cycle - return the path including the repeated node
        cycle_start = path.index(spec_id)
        return path[cycle_start:] + [spec_id]

    # Already fully explored this node
    if spec_id in visited:
        return None

    # Find the spec directory
    spec_dir = find_spec_dir(project_dir, spec_id)
    if spec_dir is None:
        # Spec doesn't exist - no cycle possible through it
        return None

    # Add to current path
    path = path + [spec_id]

    # Get dependencies
    dependencies = load_dependencies(spec_dir)

    # Explore each dependency
    for dep_id in dependencies:
        cycle = detect_circular_dependencies(project_dir, dep_id, visited, path)
        if cycle is not None:
            return cycle

    # Mark as fully explored
    visited.add(spec_id)

    return None


def validate_dependencies(
    project_dir: Path,
    spec_id: str,
    depends_on: list[str],
) -> tuple[bool, str]:
    """
    Validate that a list of dependencies is valid before creating a spec.

    Checks that:
    1. All dependency specs exist
    2. Adding these dependencies won't create a circular dependency

    Args:
        project_dir: Project root directory
        spec_id: The spec ID that will have these dependencies
        depends_on: List of spec IDs to depend on

    Returns:
        Tuple of (is_valid, error_message)
        If valid, returns (True, "")
        If invalid, returns (False, "reason")
    """
    if not depends_on:
        return True, ""

    specs_dir = project_dir / ".auto-claude" / "specs"

    # Check all dependencies exist
    for dep_id in depends_on:
        dep_dir = find_spec_dir(project_dir, dep_id)
        if dep_dir is None:
            return False, f"Dependency '{dep_id}' does not exist"

    # Check for circular dependencies
    # Temporarily simulate the new spec with its dependencies
    # by checking if any dependency has a path back to this spec

    for dep_id in depends_on:
        cycle = detect_circular_dependencies(project_dir, dep_id)
        if cycle is not None:
            # Check if the cycle would include our new spec
            # This can happen if dep_id eventually depends on something
            # that will depend on spec_id
            if spec_id in cycle:
                cycle_str = " -> ".join(cycle)
                return False, f"Circular dependency detected: {cycle_str}"

    # Check if any dependency directly or indirectly depends on spec_id
    for dep_id in depends_on:
        if _has_path_to(project_dir, dep_id, spec_id, set()):
            return (
                False,
                f"Circular dependency: '{dep_id}' already depends on '{spec_id}'",
            )

    return True, ""


def _has_path_to(
    project_dir: Path,
    from_spec: str,
    to_spec: str,
    visited: set[str],
) -> bool:
    """
    Check if there's a dependency path from one spec to another.

    Args:
        project_dir: Project root directory
        from_spec: Starting spec ID
        to_spec: Target spec ID
        visited: Set of already visited specs (for cycle prevention)

    Returns:
        True if from_spec depends (directly or transitively) on to_spec
    """
    if from_spec in visited:
        return False

    visited.add(from_spec)

    spec_dir = find_spec_dir(project_dir, from_spec)
    if spec_dir is None:
        return False

    dependencies = load_dependencies(spec_dir)

    for dep_id in dependencies:
        if dep_id == to_spec:
            return True
        if _has_path_to(project_dir, dep_id, to_spec, visited):
            return True

    return False


def get_all_dependencies(project_dir: Path, spec_id: str) -> list[str]:
    """
    Get all transitive dependencies for a spec.

    Args:
        project_dir: Project root directory
        spec_id: The spec ID to get dependencies for

    Returns:
        List of all spec IDs this spec depends on (directly and transitively)
    """
    result = []
    visited = set()

    def collect(current_id: str) -> None:
        if current_id in visited:
            return
        visited.add(current_id)

        spec_dir = find_spec_dir(project_dir, current_id)
        if spec_dir is None:
            return

        dependencies = load_dependencies(spec_dir)
        for dep_id in dependencies:
            if dep_id not in result:
                result.append(dep_id)
            collect(dep_id)

    collect(spec_id)
    return result


__all__ = [
    "load_dependencies",
    "check_unmet_dependencies",
    "detect_circular_dependencies",
    "validate_dependencies",
    "get_all_dependencies",
    "find_spec_dir",
    "get_spec_status",
    "is_spec_merged_or_complete",
]
