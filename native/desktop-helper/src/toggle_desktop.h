#pragma once

#include <string>

/** Runs one toggleDesktop request; writes the complete result line to out, returns the process exit code. */
int runToggleDesktop(std::string& out);
