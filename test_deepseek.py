"""
Test DeepSeek API connection
"""
import requests
from config import LLM_API_KEY, LLM_MODEL, LLM_API_URL

def test_deepseek():
    print("=" * 50)
    print("Testing DeepSeek API connection...")
    print(f"Model: {LLM_MODEL}")
    print(f"URL: {LLM_API_URL}")
    print("=" * 50)
    
    headers = {
        "Authorization": f"Bearer {LLM_API_KEY}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello, this is a test. Reply with 'DeepSeek API is working!'"}
        ],
        "temperature": 0.1,
        "max_tokens": 100
    }
    
    try:
        response = requests.post(LLM_API_URL, headers=headers, json=payload, timeout=30)
        print(f"\nStatus Code: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            reply = data["choices"][0]["message"]["content"]
            print(f"\n✅ DeepSeek API is working!")
            print(f"Response: {reply}")
            
            # Show token usage
            if "usage" in data:
                usage = data["usage"]
                print(f"\nToken usage:")
                print(f"  Prompt tokens: {usage.get('prompt_tokens', 'N/A')}")
                print(f"  Completion tokens: {usage.get('completion_tokens', 'N/A')}")
                print(f"  Total tokens: {usage.get('total_tokens', 'N/A')}")
        else:
            print(f"\n❌ API Error:")
            print(response.text)
            
    except Exception as e:
        print(f"\n❌ Connection failed: {e}")

if __name__ == "__main__":
    test_deepseek()
