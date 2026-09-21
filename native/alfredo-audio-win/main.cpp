// alfredo-audio, for Windows.
//
//   alfredo-audio record <dir> [--mic-only]
//                                  writes <dir>\system.wav and <dir>\mic.wav
//                                  until stdin closes, then finalises.
//                                  --mic-only skips system audio entirely.
//
// The same contract as the macOS helper in ../alfredo-audio, so the server
// does not care which one it is talking to. Where macOS has ScreenCaptureKit,
// Windows has WASAPI loopback: a capture stream opened on the *rendering*
// endpoint, which hands back exactly what the speakers are playing. It has
// been in Windows since Vista and needs no virtual cable and no driver.
//
// Each endpoint is written in its own mix format (usually 48 kHz float
// stereo); the server mixes and resamples with ffmpeg afterwards, the same as
// it does for the Mac.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>

#include <atomic>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

namespace {

std::atomic<bool> running{true};

/** A WAV file whose sizes are patched once the recording stops. */
class Wav {
 public:
  bool open(const std::string& path, const WAVEFORMATEX* fmt) {
    file_ = CreateFileA(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS,
                        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file_ == INVALID_HANDLE_VALUE) return false;
    const DWORD fmtBytes = sizeof(WAVEFORMATEX) + fmt->cbSize;
    const char riff[4] = {'R', 'I', 'F', 'F'};
    const char wave[4] = {'W', 'A', 'V', 'E'};
    const char fmtId[4] = {'f', 'm', 't', ' '};
    const char dataId[4] = {'d', 'a', 't', 'a'};
    DWORD zero = 0;
    write(riff, 4);
    write(&zero, 4);  // RIFF size, patched at the end
    write(wave, 4);
    write(fmtId, 4);
    write(&fmtBytes, 4);
    write(fmt, fmtBytes);
    write(dataId, 4);
    dataSizeAt_ = SetFilePointer(file_, 0, nullptr, FILE_CURRENT);
    write(&zero, 4);  // data size, patched at the end
    return true;
  }

  void frames(const BYTE* data, DWORD bytes) {
    if (file_ == INVALID_HANDLE_VALUE || bytes == 0) return;
    write(data, bytes);
    written_ += bytes;
  }

  /** Silence, for the gaps a loopback stream leaves when nothing is playing. */
  void silence(DWORD bytes) {
    if (file_ == INVALID_HANDLE_VALUE || bytes == 0) return;
    static std::vector<BYTE> zeros(4096, 0);
    while (bytes > 0) {
      const DWORD chunk = bytes < zeros.size() ? bytes : static_cast<DWORD>(zeros.size());
      write(zeros.data(), chunk);
      written_ += chunk;
      bytes -= chunk;
    }
  }

  void close() {
    if (file_ == INVALID_HANDLE_VALUE) return;
    const DWORD riffSize = written_ + dataSizeAt_ + 4 - 8;
    SetFilePointer(file_, 4, nullptr, FILE_BEGIN);
    write(&riffSize, 4);
    SetFilePointer(file_, dataSizeAt_, nullptr, FILE_BEGIN);
    write(&written_, 4);
    CloseHandle(file_);
    file_ = INVALID_HANDLE_VALUE;
  }

 private:
  void write(const void* p, DWORD n) {
    DWORD done = 0;
    WriteFile(file_, p, n, &done, nullptr);
  }
  HANDLE file_ = INVALID_HANDLE_VALUE;
  DWORD written_ = 0;
  DWORD dataSizeAt_ = 0;
};

/**
 * One endpoint, captured until `running` goes false.
 *
 * `loopback` decides which endpoint and which flag: the rendering one with
 * AUDCLNT_STREAMFLAGS_LOOPBACK is the whole point of this file, and is how
 * every screen recorder on Windows hears the call.
 */
bool capture(bool loopback, const std::string& path, std::atomic<bool>* started) {
  IMMDeviceEnumerator* enumerator = nullptr;
  IMMDevice* device = nullptr;
  IAudioClient* client = nullptr;
  IAudioCaptureClient* capture = nullptr;
  WAVEFORMATEX* mix = nullptr;
  Wav wav;
  bool ok = false;

  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return false;
  do {
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator))))
      break;
    // eRender + loopback is the system's own audio; eCapture is the microphone.
    if (FAILED(enumerator->GetDefaultAudioEndpoint(loopback ? eRender : eCapture, eConsole, &device))) break;
    if (FAILED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&client)))) break;
    if (FAILED(client->GetMixFormat(&mix))) break;

    const DWORD flags = loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
    const REFERENCE_TIME oneSecond = 10'000'000;
    if (FAILED(client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, oneSecond, 0, mix, nullptr))) break;
    if (FAILED(client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture)))) break;
    if (!wav.open(path, mix)) break;
    if (FAILED(client->Start())) break;

    ok = true;
    if (started) started->store(true);

    const UINT32 frameBytes = mix->nBlockAlign;
    while (running.load()) {
      UINT32 packet = 0;
      if (FAILED(capture->GetNextPacketSize(&packet))) break;
      if (packet == 0) {
        Sleep(10);
        continue;
      }
      while (packet > 0) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD packetFlags = 0;
        if (FAILED(capture->GetBuffer(&data, &frames, &packetFlags, nullptr, nullptr))) break;
        // A silent loopback stream is handed over as a flag, not as samples;
        // writing the zeros keeps both files the same length as the meeting.
        if (packetFlags & AUDCLNT_BUFFERFLAGS_SILENT) wav.silence(frames * frameBytes);
        else wav.frames(data, frames * frameBytes);
        capture->ReleaseBuffer(frames);
        if (FAILED(capture->GetNextPacketSize(&packet))) break;
      }
    }
    client->Stop();
  } while (false);

  wav.close();
  if (mix) CoTaskMemFree(mix);
  if (capture) capture->Release();
  if (client) client->Release();
  if (device) device->Release();
  if (enumerator) enumerator->Release();
  CoUninitialize();
  return ok;
}

BOOL WINAPI onConsoleSignal(DWORD) {
  running.store(false);
  return TRUE;
}

}  // namespace

int main(int argc, char** argv) {
  std::string dir;
  bool micOnly = false;
  bool record = false;
  for (int i = 1; i < argc; i++) {
    const std::string arg = argv[i];
    if (arg == "record") record = true;
    else if (arg == "--mic-only") micOnly = true;
    else if (!arg.empty() && arg[0] != '-' && dir.empty() && record) dir = arg;
  }
  if (!record || dir.empty()) {
    std::fprintf(stderr, "usage: alfredo-audio record <dir> [--mic-only]\n");
    return 2;
  }
  CreateDirectoryA(dir.c_str(), nullptr);
  SetConsoleCtrlHandler(onConsoleSignal, TRUE);

  std::atomic<bool> systemUp{false};
  std::thread systemThread;
  if (!micOnly) systemThread = std::thread([&] { capture(true, dir + "\\system.wav", &systemUp); });
  std::thread micThread([&] { capture(false, dir + "\\mic.wav", nullptr); });

  // Give the loopback stream a moment to say whether it came up, then tell the
  // server which it is, in the same words the Mac helper uses.
  Sleep(400);
  std::printf("%s\n", (!micOnly && systemUp.load()) ? "recording" : "mic-only");
  std::fflush(stdout);

  // Stops when the server closes this pipe. Windows has no SIGINT to send a
  // child, and a hard kill would leave both wav headers unfinished.
  char buf[256];
  DWORD read = 0;
  while (running.load()) {
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), buf, sizeof(buf), &read, nullptr) || read == 0) break;
    if (std::string(buf, read).find("stop") != std::string::npos) break;
  }
  running.store(false);

  if (systemThread.joinable()) systemThread.join();
  micThread.join();
  std::printf("done\n");
  std::fflush(stdout);
  return 0;
}
