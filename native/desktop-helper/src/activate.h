#pragma once

#include <string>

/** Runs one activate request; writes the complete result line to out, returns the process exit code. */
int runActivate(const std::string& exePathUtf8, std::string& out);
