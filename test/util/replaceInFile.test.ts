import { describe, expect, test, mock } from "bun:test";
import fs from "fs/promises";
import { replaceInFile } from "../../src/util";

describe("replaceInFile", () => {
  test("replaces multiple strings in a file", async () => {
    const filePath = "/path/to/file.txt";
    const fileContent = "Hello, world! This is a test.";
    const replacements = [
      { search: "Hello", replace: "Hi" },
      { search: "world", replace: "everyone" },
      { search: "test", replace: "sample" }
    ];
    
    let capturedNewContent = "";
    
    // Mock fs.readFile
    const originalReadFile = fs.readFile;
    // @ts-ignore - Mock implementation
    fs.readFile = mock((path: string, encoding: string) => {
      expect(path).toBe(filePath);
      expect(encoding).toBe("utf-8");
      return Promise.resolve(fileContent);
    });
    
    // Mock fs.writeFile
    const originalWriteFile = fs.writeFile;
    // @ts-ignore - Mock implementation
    fs.writeFile = mock((path: string, content: string) => {
      expect(path).toBe(filePath);
      capturedNewContent = content;
      return Promise.resolve();
    });
    
    await replaceInFile(filePath, replacements);
    
    // Verify the content was replaced correctly
    expect(capturedNewContent).toBe("Hi, everyone! This is a sample.");
    
    // Verify the mocks were called
    expect(fs.readFile).toHaveBeenCalledTimes(1);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    
    // Restore original functions
    fs.readFile = originalReadFile;
    fs.writeFile = originalWriteFile;
  });
  
  test("applies replacements in order", async () => {
    const filePath = "/path/to/file.txt";
    const fileContent = "test";
    const replacements = [
      { search: "test", replace: "temp" },
      { search: "temp", replace: "final" }
    ];
    
    let capturedNewContent = "";
    
    // Mock fs functions
    const originalReadFile = fs.readFile;
    const originalWriteFile = fs.writeFile;
    // @ts-ignore - Mock implementation
    fs.readFile = mock(() => Promise.resolve(fileContent));
    // @ts-ignore - Mock implementation
    fs.writeFile = mock((path: string, content: string) => {
      capturedNewContent = content;
      return Promise.resolve();
    });
    
    await replaceInFile(filePath, replacements);
    
    // Verify replacements were applied in order
    expect(capturedNewContent).toBe("final");
    
    // Restore original functions
    fs.readFile = originalReadFile;
    fs.writeFile = originalWriteFile;
  });
});
