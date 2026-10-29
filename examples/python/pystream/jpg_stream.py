import time

import cv2
import numpy as np
from racs_python import RacsClient


def stream_video(server_ip, device_id):
    """
    Shows the device's live JPEG stream as a video with FPS counter.
    """
    cam = RacsClient(f"http://{server_ip}").camera(device_id)

    # --- FPS Variables ---
    prev_time = 0
    # ---------------------
    try:
        with cam.live(format="jpeg", quality=80) as stream:
            for img in stream:
                image_array = np.frombuffer(img.data, dtype=np.uint8)
                frame = cv2.imdecode(image_array, cv2.IMREAD_COLOR)

                if frame is not None:
                    # --- FPS Calculation ---
                    new_time = time.time()
                    # Calculate time difference (avoid division by zero on very first frame)
                    diff = new_time - prev_time
                    fps = 1 / diff if diff > 0 else 0
                    prev_time = new_time

                    # Convert FPS to integer string
                    fps_text = f"FPS: {int(fps)}"

                    # Draw FPS on the frame (Green text, top-left corner)
                    cv2.putText(
                        frame,
                        fps_text,
                        (10, 30),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        1,
                        (0, 255, 0),
                        2,
                        cv2.LINE_AA,
                    )
                    # -----------------------

                    cv2.imshow("Device Stream", frame)
                else:
                    print("Received data but could not decode image.")

                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

    except KeyboardInterrupt:
        print("\nStream stopped by user.")
    except Exception as e:
        print(f"\nAn error occurred: {e}")
    finally:
        cv2.destroyAllWindows()
        print("Video window closed.")


if __name__ == "__main__":
    SERVER_ADDRESS = "127.0.0.1:8742"
    TARGET_DEVICE_ID = 0

    stream_video(SERVER_ADDRESS, TARGET_DEVICE_ID)
