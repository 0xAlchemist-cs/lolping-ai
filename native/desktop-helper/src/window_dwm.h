#pragma once

#include <cstdint>
#include <string>

int runFlushComposition(std::string& out);
int runStyleWindow(std::uint64_t hwnd, std::uint32_t ownerPid, std::string& out);
