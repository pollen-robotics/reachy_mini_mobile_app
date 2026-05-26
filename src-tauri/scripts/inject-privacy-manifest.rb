#!/usr/bin/env ruby
# frozen_string_literal: true

# inject-privacy-manifest.rb
# ──────────────────────────
# Patches the regenerated iOS xcodeproj so the PrivacyInfo.xcprivacy
# file lands in the app bundle root after `xcodebuild` runs.
#
# Why this script exists
# ──────────────────────
# `tauri ios init` (called by CI on every job) wipes
# `src-tauri/gen/apple/` and rebuilds the xcodeproj from a fresh
# `project.yml` via xcodegen. xcodegen's folder scan creates a
# FileReference for the privacy manifest, but - on the runner's
# pinned xcodegen version - it does NOT add the file to the
# "Copy Bundle Resources" build phase, because `.xcprivacy` was
# only added to xcodegen's default-resource extension list in
# v2.42 (2024-06) and the runner can lag.
#
# The result: the binary ships without `PrivacyInfo.xcprivacy`
# at the bundle root, and App Review auto-rejects with
# ITMS-91053 ("Missing API declaration") on the first upload.
#
# This script is a thin idempotent fix-up. It:
#   1. Opens the xcodeproj.
#   2. Locates the iOS app target.
#   3. Ensures the file reference exists under the iOS source
#      group (xcodegen usually already created it, but we add
#      it defensively if missing).
#   4. Adds the file reference to the target's Resources build
#      phase if it isn't already there.
#   5. Saves the project.
#
# Idempotency matters: the script is called both in CI (after
# `tauri ios init`) and locally (whenever a dev wants to refresh
# the committed pbxproj). Running it twice in a row must be a
# no-op on the second run.
#
# Usage
# ─────
#   ruby src-tauri/scripts/inject-privacy-manifest.rb
#
# Optional env vars:
#   XCODEPROJ_PATH   override the path to the .xcodeproj
#   TARGET_NAME      override the target name to patch
#   RELATIVE_PATH    override the relative path of the manifest

require 'xcodeproj'

XCODEPROJ_PATH = ENV.fetch(
  'XCODEPROJ_PATH',
  File.expand_path(
    '../gen/apple/reachy_mini_mobile_app.xcodeproj',
    __dir__,
  ),
)
TARGET_NAME = ENV.fetch('TARGET_NAME', 'reachy_mini_mobile_app_iOS')
RELATIVE_PATH = ENV.fetch(
  'RELATIVE_PATH',
  'reachy_mini_mobile_app_iOS/PrivacyInfo.xcprivacy',
)
MANIFEST_BASENAME = File.basename(RELATIVE_PATH)
GROUP_PATH = File.dirname(RELATIVE_PATH)

unless File.directory?(XCODEPROJ_PATH)
  warn "[privacy-manifest] xcodeproj not found at #{XCODEPROJ_PATH}"
  exit 1
end

project = Xcodeproj::Project.open(XCODEPROJ_PATH)

target = project.targets.find { |t| t.name == TARGET_NAME }
unless target
  warn "[privacy-manifest] target '#{TARGET_NAME}' not found in xcodeproj"
  exit 1
end

# Resolve (or create) the group that maps to the iOS source folder.
# `find_subpath(..., true)` creates intermediate groups idempotently.
group = project.main_group.find_subpath(GROUP_PATH, true)
group.set_source_tree('<group>') if group.source_tree.nil?

# Look for an existing file reference whose `path` ends with the
# manifest basename. xcodegen sometimes stores it as a relative path
# and sometimes as just the basename depending on group layout, so
# we match permissively.
file_ref = group.files.find do |f|
  f.path == MANIFEST_BASENAME ||
    f.path == RELATIVE_PATH ||
    f.path&.end_with?(MANIFEST_BASENAME)
end

if file_ref.nil?
  file_ref = group.new_file(MANIFEST_BASENAME)
  puts "[privacy-manifest] added file ref #{MANIFEST_BASENAME} to group #{GROUP_PATH}"
else
  puts "[privacy-manifest] file ref already present: #{file_ref.path}"
end

resources_phase = target.resources_build_phase
already_listed = resources_phase.files_references.any? do |ref|
  ref == file_ref ||
    ref.path == file_ref.path ||
    ref.path == MANIFEST_BASENAME
end

if already_listed
  puts "[privacy-manifest] already listed in Copy Bundle Resources, nothing to do"
else
  resources_phase.add_file_reference(file_ref)
  puts "[privacy-manifest] added to Copy Bundle Resources of #{TARGET_NAME}"
end

project.save
puts "[privacy-manifest] xcodeproj saved at #{XCODEPROJ_PATH}"
