// Package core owns domain state and coordinates the pi sidecar.
// See PLAN.md §3.2. Real implementation lands in task 7.
package core

// Engine is the backend orchestrator: single-writer actor, sequencer,
// snapshot engine, and command router.
type Engine struct{}
