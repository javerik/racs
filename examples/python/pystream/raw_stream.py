import sys
import time

import cv2
from racs_python import RacsClient

SERVER_ADDRESS = "http://127.0.0.1:8742"
TARGET_DEVICE_ID = 0


def stream_raw_video():
    cam = RacsClient(SERVER_ADDRESS).camera(TARGET_DEVICE_ID)
    print(f"Streaming raw frames from device {TARGET_DEVICE_ID}. Press 'q' to quit.")

    prev_time = 0
    try:
        # The live stream sends the frame size with the frames, so nothing has to be read up front.
        # pixel_depth="mono16" would deliver the camera's full bit depth as uint16.
        with cam.live(format="raw") as stream:
            for frame in stream:
                # .copy() for writable memory to draw on
                image = frame.to_numpy().copy()

                # --- FPS Calculation ---
                new_time = time.time()
                diff = new_time - prev_time
                fps = 1 / diff if diff > 0 else 0
                prev_time = new_time

                # Draw FPS and the server's dropped-frame counter (White text)
                cv2.putText(image, f"FPS: {int(fps)}  dropped: {frame.dropped}", (10, 30),
                            cv2.FONT_HERSHEY_SIMPLEX, 1, 255, 2, cv2.LINE_AA)

                cv2.imshow('Device Stream (RAW)', image)

                if cv2.waitKey(1) & 0xFF == ord('q'):
                    break

    except KeyboardInterrupt:
        print("\nStream stopped by user.")
    except Exception as e:
        print(f"\nAn error occurred: {e}")
        sys.exit(1)
    finally:
        cv2.destroyAllWindows()


if __name__ == "__main__":
    stream_raw_video()
