#!/usr/bin/env python3
"""
Tests for Spec Dependency Module
=================================

Tests the dependencies.py module functionality including:
- Loading dependencies from requirements.json
- Checking spec status from implementation_plan.json
- Finding spec directories by ID
- Checking unmet dependencies
- Detecting circular dependencies
- Validating dependency configurations
"""

import json
import pytest
from pathlib import Path
import tempfile
import shutil

from dependencies import (
    load_dependencies,
    get_spec_status,
    is_spec_merged_or_complete,
    find_spec_dir,
    check_unmet_dependencies,
    detect_circular_dependencies,
    validate_dependencies,
    get_all_dependencies,
)


@pytest.fixture
def temp_project() -> Path:
    """Create a temporary project directory that's cleaned up after the test."""
    temp_path = Path(tempfile.mkdtemp())
    yield temp_path
    shutil.rmtree(temp_path, ignore_errors=True)


@pytest.fixture
def project_with_specs(temp_project: Path) -> Path:
    """Create a project with .auto-claude/specs structure."""
    specs_dir = temp_project / ".auto-claude" / "specs"
    specs_dir.mkdir(parents=True)
    return temp_project


def create_spec(
    project_dir: Path,
    spec_id: str,
    depends_on: list[str] = None,
    status: str = None,
    subtasks: list[dict] = None,
) -> Path:
    """Helper to create a spec directory with required files."""
    spec_dir = project_dir / ".auto-claude" / "specs" / spec_id
    spec_dir.mkdir(parents=True, exist_ok=True)

    # Create requirements.json if dependencies specified
    if depends_on is not None:
        requirements = {"depends_on": depends_on}
        with open(spec_dir / "requirements.json", "w") as f:
            json.dump(requirements, f)

    # Create implementation_plan.json
    plan = {"feature": spec_id, "status": status or "pending", "phases": []}

    if subtasks is not None:
        plan["phases"] = [{"phase": 1, "name": "Test Phase", "subtasks": subtasks}]

    with open(spec_dir / "implementation_plan.json", "w") as f:
        json.dump(plan, f)

    return spec_dir


class TestLoadDependencies:
    """Tests for load_dependencies function."""

    def test_returns_empty_list_when_no_requirements_file(self, temp_project: Path):
        """Returns empty list when requirements.json doesn't exist."""
        spec_dir = temp_project / "spec"
        spec_dir.mkdir()

        result = load_dependencies(spec_dir)

        assert result == []

    def test_returns_empty_list_when_no_depends_on_field(self, temp_project: Path):
        """Returns empty list when depends_on field is missing."""
        spec_dir = temp_project / "spec"
        spec_dir.mkdir()
        with open(spec_dir / "requirements.json", "w") as f:
            json.dump({"task": "some task"}, f)

        result = load_dependencies(spec_dir)

        assert result == []

    def test_returns_dependencies_list(self, temp_project: Path):
        """Returns the depends_on list from requirements.json."""
        spec_dir = temp_project / "spec"
        spec_dir.mkdir()
        with open(spec_dir / "requirements.json", "w") as f:
            json.dump({"depends_on": ["spec-a", "spec-b"]}, f)

        result = load_dependencies(spec_dir)

        assert result == ["spec-a", "spec-b"]

    def test_handles_invalid_json(self, temp_project: Path):
        """Returns empty list when JSON is invalid."""
        spec_dir = temp_project / "spec"
        spec_dir.mkdir()
        with open(spec_dir / "requirements.json", "w") as f:
            f.write("not valid json")

        result = load_dependencies(spec_dir)

        assert result == []


class TestGetSpecStatus:
    """Tests for get_spec_status function."""

    def test_returns_pending_when_no_plan_file(self, temp_project: Path):
        """Returns pending when implementation_plan.json doesn't exist."""
        spec_dir = temp_project / "spec"
        spec_dir.mkdir()

        result = get_spec_status(spec_dir)

        assert result == "pending"

    def test_returns_merged_when_status_is_merged(self, temp_project: Path):
        """Returns merged when plan status is explicitly merged."""
        spec_dir = temp_project / "spec"
        spec_dir.mkdir()
        with open(spec_dir / "implementation_plan.json", "w") as f:
            json.dump({"status": "merged", "phases": []}, f)

        result = get_spec_status(spec_dir)

        assert result == "merged"

    def test_returns_complete_when_all_subtasks_completed(self, temp_project: Path):
        """Returns complete when all subtasks are completed."""
        spec_dir = temp_project / "spec"
        spec_dir.mkdir()
        plan = {
            "phases": [
                {
                    "subtasks": [
                        {"status": "completed"},
                        {"status": "completed"},
                    ]
                }
            ]
        }
        with open(spec_dir / "implementation_plan.json", "w") as f:
            json.dump(plan, f)

        result = get_spec_status(spec_dir)

        assert result == "complete"

    def test_returns_in_progress_when_some_completed(self, temp_project: Path):
        """Returns in_progress when some subtasks are completed."""
        spec_dir = temp_project / "spec"
        spec_dir.mkdir()
        plan = {
            "phases": [
                {
                    "subtasks": [
                        {"status": "completed"},
                        {"status": "pending"},
                    ]
                }
            ]
        }
        with open(spec_dir / "implementation_plan.json", "w") as f:
            json.dump(plan, f)

        result = get_spec_status(spec_dir)

        assert result == "in_progress"

    def test_returns_pending_when_no_subtasks_completed(self, temp_project: Path):
        """Returns pending when no subtasks are completed."""
        spec_dir = temp_project / "spec"
        spec_dir.mkdir()
        plan = {
            "phases": [
                {
                    "subtasks": [
                        {"status": "pending"},
                        {"status": "pending"},
                    ]
                }
            ]
        }
        with open(spec_dir / "implementation_plan.json", "w") as f:
            json.dump(plan, f)

        result = get_spec_status(spec_dir)

        assert result == "pending"

    def test_returns_pending_when_no_phases(self, temp_project: Path):
        """Returns pending when there are no phases."""
        spec_dir = temp_project / "spec"
        spec_dir.mkdir()
        with open(spec_dir / "implementation_plan.json", "w") as f:
            json.dump({"phases": []}, f)

        result = get_spec_status(spec_dir)

        assert result == "pending"


class TestIsMergedOrComplete:
    """Tests for is_spec_merged_or_complete function."""

    def test_returns_true_when_merged(self, temp_project: Path):
        """Returns True when spec is merged."""
        spec_dir = temp_project / "spec"
        spec_dir.mkdir()
        with open(spec_dir / "implementation_plan.json", "w") as f:
            json.dump({"status": "merged"}, f)

        result = is_spec_merged_or_complete(spec_dir)

        assert result is True

    def test_returns_true_when_complete(self, temp_project: Path):
        """Returns True when all subtasks are complete."""
        spec_dir = temp_project / "spec"
        spec_dir.mkdir()
        plan = {
            "phases": [
                {"subtasks": [{"status": "completed"}]}
            ]
        }
        with open(spec_dir / "implementation_plan.json", "w") as f:
            json.dump(plan, f)

        result = is_spec_merged_or_complete(spec_dir)

        assert result is True

    def test_returns_false_when_pending(self, temp_project: Path):
        """Returns False when spec is still pending."""
        spec_dir = temp_project / "spec"
        spec_dir.mkdir()
        plan = {
            "phases": [
                {"subtasks": [{"status": "pending"}]}
            ]
        }
        with open(spec_dir / "implementation_plan.json", "w") as f:
            json.dump(plan, f)

        result = is_spec_merged_or_complete(spec_dir)

        assert result is False

    def test_returns_false_when_in_progress(self, temp_project: Path):
        """Returns False when spec is in progress."""
        spec_dir = temp_project / "spec"
        spec_dir.mkdir()
        plan = {
            "phases": [
                {"subtasks": [{"status": "completed"}, {"status": "pending"}]}
            ]
        }
        with open(spec_dir / "implementation_plan.json", "w") as f:
            json.dump(plan, f)

        result = is_spec_merged_or_complete(spec_dir)

        assert result is False


class TestFindSpecDir:
    """Tests for find_spec_dir function."""

    def test_returns_none_when_specs_dir_missing(self, temp_project: Path):
        """Returns None when .auto-claude/specs doesn't exist."""
        result = find_spec_dir(temp_project, "any-spec")

        assert result is None

    def test_finds_exact_match(self, project_with_specs: Path):
        """Finds spec by exact name match."""
        spec_dir = project_with_specs / ".auto-claude" / "specs" / "my-feature"
        spec_dir.mkdir()

        result = find_spec_dir(project_with_specs, "my-feature")

        assert result == spec_dir

    def test_finds_numbered_spec(self, project_with_specs: Path):
        """Finds spec by name when stored with number prefix."""
        spec_dir = project_with_specs / ".auto-claude" / "specs" / "001-my-feature"
        spec_dir.mkdir()

        result = find_spec_dir(project_with_specs, "001-my-feature")

        assert result == spec_dir

    def test_finds_by_suffix_without_number(self, project_with_specs: Path):
        """Finds numbered spec by name without number."""
        spec_dir = project_with_specs / ".auto-claude" / "specs" / "001-my-feature"
        spec_dir.mkdir()

        result = find_spec_dir(project_with_specs, "my-feature")

        assert result == spec_dir

    def test_returns_none_for_nonexistent_spec(self, project_with_specs: Path):
        """Returns None when spec doesn't exist."""
        (project_with_specs / ".auto-claude" / "specs" / "other-spec").mkdir()

        result = find_spec_dir(project_with_specs, "nonexistent")

        assert result is None


class TestCheckUnmetDependencies:
    """Tests for check_unmet_dependencies function."""

    def test_returns_empty_when_no_dependencies(self, project_with_specs: Path):
        """Returns empty list when spec has no dependencies."""
        spec_dir = create_spec(project_with_specs, "my-spec")

        result = check_unmet_dependencies(project_with_specs, spec_dir)

        assert result == []

    def test_returns_empty_when_all_deps_met(self, project_with_specs: Path):
        """Returns empty list when all dependencies are complete."""
        # Create dependency spec that is complete
        create_spec(
            project_with_specs,
            "dep-spec",
            subtasks=[{"status": "completed"}],
        )
        # Create spec that depends on it
        spec_dir = create_spec(
            project_with_specs,
            "my-spec",
            depends_on=["dep-spec"],
        )

        result = check_unmet_dependencies(project_with_specs, spec_dir)

        assert result == []

    def test_returns_unmet_when_dep_not_found(self, project_with_specs: Path):
        """Returns unmet dependency when dep spec doesn't exist."""
        spec_dir = create_spec(
            project_with_specs,
            "my-feature",
            depends_on=["totally-missing-xyz"],
        )

        result = check_unmet_dependencies(project_with_specs, spec_dir)

        assert len(result) == 1
        assert result[0]["spec_id"] == "totally-missing-xyz"
        assert result[0]["status"] == "not_found"
        assert "does not exist" in result[0]["reason"]

    def test_returns_unmet_when_dep_not_complete(self, project_with_specs: Path):
        """Returns unmet dependency when dep is not complete."""
        # Create dependency spec that is in progress
        create_spec(
            project_with_specs,
            "dep-spec",
            subtasks=[{"status": "completed"}, {"status": "pending"}],
        )
        # Create spec that depends on it
        spec_dir = create_spec(
            project_with_specs,
            "my-spec",
            depends_on=["dep-spec"],
        )

        result = check_unmet_dependencies(project_with_specs, spec_dir)

        assert len(result) == 1
        assert result[0]["spec_id"] == "dep-spec"
        assert result[0]["status"] == "in_progress"
        assert "not yet complete" in result[0]["reason"]

    def test_returns_multiple_unmet_deps(self, project_with_specs: Path):
        """Returns multiple unmet dependencies."""
        # Create one complete dep and two incomplete deps
        create_spec(
            project_with_specs,
            "complete-auth",
            subtasks=[{"status": "completed"}],
        )
        create_spec(
            project_with_specs,
            "incomplete-login",
            subtasks=[{"status": "pending"}],
        )
        # Create spec with multiple deps (use unique names that won't partial-match)
        spec_dir = create_spec(
            project_with_specs,
            "my-dashboard",
            depends_on=["complete-auth", "incomplete-login", "nonexistent-xyz"],
        )

        result = check_unmet_dependencies(project_with_specs, spec_dir)

        assert len(result) == 2
        spec_ids = [r["spec_id"] for r in result]
        assert "incomplete-login" in spec_ids
        assert "nonexistent-xyz" in spec_ids
        assert "complete-auth" not in spec_ids


class TestDetectCircularDependencies:
    """Tests for detect_circular_dependencies function."""

    def test_returns_none_when_no_dependencies(self, project_with_specs: Path):
        """Returns None when spec has no dependencies."""
        create_spec(project_with_specs, "my-spec")

        result = detect_circular_dependencies(project_with_specs, "my-spec")

        assert result is None

    def test_returns_none_for_linear_deps(self, project_with_specs: Path):
        """Returns None for linear dependency chain (A -> B -> C)."""
        create_spec(project_with_specs, "spec-c")
        create_spec(project_with_specs, "spec-b", depends_on=["spec-c"])
        create_spec(project_with_specs, "spec-a", depends_on=["spec-b"])

        result = detect_circular_dependencies(project_with_specs, "spec-a")

        assert result is None

    def test_detects_direct_self_cycle(self, project_with_specs: Path):
        """Detects when spec depends on itself."""
        create_spec(project_with_specs, "self-dep", depends_on=["self-dep"])

        result = detect_circular_dependencies(project_with_specs, "self-dep")

        assert result is not None
        assert "self-dep" in result

    def test_detects_two_node_cycle(self, project_with_specs: Path):
        """Detects cycle between two specs (A -> B -> A)."""
        create_spec(project_with_specs, "spec-a", depends_on=["spec-b"])
        create_spec(project_with_specs, "spec-b", depends_on=["spec-a"])

        result = detect_circular_dependencies(project_with_specs, "spec-a")

        assert result is not None
        assert "spec-a" in result
        assert "spec-b" in result

    def test_detects_multi_node_cycle(self, project_with_specs: Path):
        """Detects cycle across multiple specs (A -> B -> C -> A)."""
        create_spec(project_with_specs, "spec-a", depends_on=["spec-b"])
        create_spec(project_with_specs, "spec-b", depends_on=["spec-c"])
        create_spec(project_with_specs, "spec-c", depends_on=["spec-a"])

        result = detect_circular_dependencies(project_with_specs, "spec-a")

        assert result is not None
        assert len(result) >= 3

    def test_returns_none_for_nonexistent_spec(self, project_with_specs: Path):
        """Returns None when spec doesn't exist."""
        result = detect_circular_dependencies(project_with_specs, "nonexistent")

        assert result is None


class TestValidateDependencies:
    """Tests for validate_dependencies function."""

    def test_valid_when_no_dependencies(self, project_with_specs: Path):
        """Returns valid when no dependencies specified."""
        valid, error = validate_dependencies(
            project_with_specs,
            "new-spec",
            [],
        )

        assert valid is True
        assert error == ""

    def test_valid_when_deps_exist(self, project_with_specs: Path):
        """Returns valid when all dependencies exist."""
        create_spec(project_with_specs, "dep-a")
        create_spec(project_with_specs, "dep-b")

        valid, error = validate_dependencies(
            project_with_specs,
            "new-spec",
            ["dep-a", "dep-b"],
        )

        assert valid is True
        assert error == ""

    def test_invalid_when_dep_missing(self, project_with_specs: Path):
        """Returns invalid when dependency doesn't exist."""
        create_spec(project_with_specs, "dep-a")

        valid, error = validate_dependencies(
            project_with_specs,
            "new-spec",
            ["dep-a", "missing-dep"],
        )

        assert valid is False
        assert "missing-dep" in error
        assert "does not exist" in error

    def test_invalid_when_would_create_cycle(self, project_with_specs: Path):
        """Returns invalid when dependency would create circular reference."""
        # Create A -> B (A depends on B)
        create_spec(project_with_specs, "spec-b")
        create_spec(project_with_specs, "spec-a", depends_on=["spec-b"])

        # Now try to make B depend on A (would create B -> A -> B cycle)
        # We simulate this by checking if A already depends on B
        # (the actual check is for path back to spec_id)

        # For this test, we need to check the case where adding spec-a
        # as a dependency of spec-b would create a cycle
        valid, error = validate_dependencies(
            project_with_specs,
            "spec-b",  # We're adding deps to spec-b
            ["spec-a"],  # spec-a already depends on spec-b
        )

        assert valid is False
        assert "Circular" in error or "depends on" in error


class TestGetAllDependencies:
    """Tests for get_all_dependencies function."""

    def test_returns_empty_for_no_deps(self, project_with_specs: Path):
        """Returns empty list when spec has no dependencies."""
        create_spec(project_with_specs, "my-spec")

        result = get_all_dependencies(project_with_specs, "my-spec")

        assert result == []

    def test_returns_direct_deps(self, project_with_specs: Path):
        """Returns direct dependencies."""
        create_spec(project_with_specs, "dep-a")
        create_spec(project_with_specs, "dep-b")
        create_spec(
            project_with_specs,
            "my-spec",
            depends_on=["dep-a", "dep-b"],
        )

        result = get_all_dependencies(project_with_specs, "my-spec")

        assert "dep-a" in result
        assert "dep-b" in result
        assert len(result) == 2

    def test_returns_transitive_deps(self, project_with_specs: Path):
        """Returns transitive dependencies (deps of deps)."""
        create_spec(project_with_specs, "root-dep")
        create_spec(
            project_with_specs,
            "middle-dep",
            depends_on=["root-dep"],
        )
        create_spec(
            project_with_specs,
            "my-spec",
            depends_on=["middle-dep"],
        )

        result = get_all_dependencies(project_with_specs, "my-spec")

        assert "middle-dep" in result
        assert "root-dep" in result

    def test_handles_diamond_deps(self, project_with_specs: Path):
        """Handles diamond dependency pattern without duplicates."""
        # Diamond: A -> B, A -> C, B -> D, C -> D
        create_spec(project_with_specs, "spec-d")
        create_spec(project_with_specs, "spec-b", depends_on=["spec-d"])
        create_spec(project_with_specs, "spec-c", depends_on=["spec-d"])
        create_spec(
            project_with_specs,
            "spec-a",
            depends_on=["spec-b", "spec-c"],
        )

        result = get_all_dependencies(project_with_specs, "spec-a")

        # Should have B, C, D (no duplicates)
        assert "spec-b" in result
        assert "spec-c" in result
        assert "spec-d" in result
        # D should only appear once
        assert result.count("spec-d") == 1

    def test_returns_empty_for_nonexistent_spec(self, project_with_specs: Path):
        """Returns empty list for non-existent spec."""
        result = get_all_dependencies(project_with_specs, "nonexistent")

        assert result == []


class TestIntegrationScenarios:
    """Integration tests for real-world scenarios."""

    def test_spec_with_merged_dependency(self, project_with_specs: Path):
        """Spec can start when dependency is merged."""
        # Create merged dependency
        create_spec(
            project_with_specs,
            "001-auth",
            status="merged",
        )
        # Create spec depending on it
        spec_dir = create_spec(
            project_with_specs,
            "002-dashboard",
            depends_on=["001-auth"],
        )

        # Check that dependency is satisfied
        unmet = check_unmet_dependencies(project_with_specs, spec_dir)

        assert unmet == []

    def test_spec_blocked_by_incomplete_dependency(self, project_with_specs: Path):
        """Spec is blocked when dependency is incomplete."""
        # Create incomplete dependency
        create_spec(
            project_with_specs,
            "001-auth",
            subtasks=[{"status": "pending"}],
        )
        # Create spec depending on it
        spec_dir = create_spec(
            project_with_specs,
            "002-dashboard",
            depends_on=["001-auth"],
        )

        # Check that dependency is not satisfied
        unmet = check_unmet_dependencies(project_with_specs, spec_dir)

        assert len(unmet) == 1
        assert unmet[0]["spec_id"] == "001-auth"

    def test_complex_dependency_graph(self, project_with_specs: Path):
        """Complex dependency graph is correctly analyzed."""
        # Create: A -> B, A -> C, B -> D, C -> D (diamond)
        # All should be valid and no circular deps
        create_spec(project_with_specs, "spec-d")
        create_spec(project_with_specs, "spec-b", depends_on=["spec-d"])
        create_spec(project_with_specs, "spec-c", depends_on=["spec-d"])
        create_spec(
            project_with_specs,
            "spec-a",
            depends_on=["spec-b", "spec-c"],
        )

        # No circular dependencies
        cycle = detect_circular_dependencies(project_with_specs, "spec-a")
        assert cycle is None

        # All dependencies are listed
        all_deps = get_all_dependencies(project_with_specs, "spec-a")
        assert set(all_deps) == {"spec-b", "spec-c", "spec-d"}
